import { price, rate, sats } from "./math.js";
import type { Quote, SliderView, State, View } from "./types.js";

export function pendingContent(s: State) {
  return Object.values(s.content).filter(c => !s.completed[c.id]);
}
export function availableContent(s: State, q: Quote) {
  return pendingContent(s).filter(c => (!q.contentIds || q.contentIds.includes(c.id))
    && (c.kind === "seed" || !Object.values(s.content).some(x => x.kind === "seed" && !s.completed[x.id])));
}
export function sellerSpeed(s: State, sellerId: string): number | null {
  const seller = s.sellers[sellerId];
  return seller ? rate(seller.samples, s.now, s.config.sampleWindowMs, s.config.sampleMaxAgeMs) : null;
}
/** 任务有效价格上限：手动值优先，否则使用系统缺省值。系统缺省不是授权上限。 */
export function effectivePrice(s: State): bigint {
  return s.price.mode === "manual" && s.price.manualValue !== null
    ? sats(s.price.manualValue) : sats(s.config.maxBlockPrice);
}
/** 席位上限：price 策略用独立席位，speed 策略为正式席位加浮动测速席位。 */
export function seatCap(s: State): number {
  return s.preference === "price" ? s.config.priceSeats : s.config.speedSeats + s.config.speedFloatingSeats;
}
/** 允许同时占用席位的未测速卖家数量：price 无浮动限制，speed 受浮动位限位。 */
export function unmeasuredCap(s: State): number {
  return s.preference === "price" ? s.config.priceSeats : s.config.speedFloatingSeats;
}
/** 市场有效报价：不在价格上限内过滤，仅供区间与事实展示。 */
export function validQuotes(s: State): Quote[] {
  return Object.values(s.sellers).filter(x => x.online && x.blockedUntil <= s.now
    && (x.evictedVersion ?? 0) < (x.quote?.version ?? 0)).flatMap(seller => {
    const pool = Object.values(s.pools).find(p => p.sellerId === seller.id
      && ["open", "opening"].includes(p.funding) && p.scheduling !== "draining");
    const q = pool?.quote ?? seller.quote;
    return q && (pool || q.expiresAt > s.now) && availableContent(s, q).length ? [q] : [];
  });
}
/** 可用集合包含仍有效的旧池锁价合同；ceiling 为任务有效价格上限。 */
export function candidates(s: State, ceiling: bigint): Quote[] {
  return validQuotes(s).filter(q => sats(q.blockPrice) <= ceiling);
}
export const byPrice = (a: Quote, b: Quote) => sats(a.blockPrice) < sats(b.blockPrice) ? -1
  : sats(a.blockPrice) > sats(b.blockPrice) ? 1 : a.sellerId.localeCompare(b.sellerId);

export function totalSpeed(s: State, quotes: Quote[]): number {
  const values = [...new Set(quotes.map(q => q.sellerId))].map(id => sellerSpeed(s, id) ?? 0);
  return Math.min(values.reduce((a, b) => a + b, 0), s.config.receiveBytesPerSecond ?? Infinity);
}

export function recommendations(s: State): { price: SliderView; quotes: Quote[]; effective: bigint } {
  const effective = effectivePrice(s);
  const market = validQuotes(s).sort(byPrice);
  const quotes = market.filter(q => sats(q.blockPrice) <= effective);
  // 自动建议只从已报价 / 已实测事实中挑档，不推算未来速度或卖家策略。
  let recommended: string | null = null;
  if (market.length) {
    const measured = market.filter(q => sellerSpeed(s, q.sellerId) !== null);
    if (s.preference === "speed" && measured.length) {
      measured.sort((a, b) => (sellerSpeed(s, b.sellerId)! - sellerSpeed(s, a.sellerId)!) || byPrice(a, b));
      recommended = measured[0].blockPrice;
    } else recommended = market[0].blockPrice;
  }
  return {
    price: { ...s.price, recommended, effective: String(effective),
      range: market.length ? { min: market[0].blockPrice, max: market.at(-1)!.blockPrice } : null },
    quotes, effective,
  };
}

export function view(s: State): View {
  const rec = recommendations(s);
  const pools = Object.values(s.pools);
  const live = pools.filter(p => !["closed", "failed"].includes(p.funding));
  const complete = s.manifestKnown && pendingContent(s).length === 0;
  const requests = Object.values(s.requests).filter(r => r.state === "pending" || r.state === "unresolved");
  const active = live.filter(p => p.funding === "open" && p.scheduling !== "draining");
  const sustainable = totalSpeed(s, active.map(p => p.quote));
  const reasons: string[] = [];
  if (!s.manifestKnown) reasons.push("manifest-unknown");
  if (live.some(p => p.funding === "recovery")) reasons.push("recovery-required");
  if (!rec.quotes.length && !complete) reasons.push("no-eligible-seller");
  if (rec.quotes.some(q => sellerSpeed(s, q.sellerId) === null)) reasons.push("speed-unmeasured");
  if (s.price.mode === "manual" && Object.values(s.sellers).some(x => x.online && x.quote
    && sats(x.quote.blockPrice) > sats(s.price.manualValue!))) reasons.push("price-limit");
  if (!complete && !requests.length && s.intent === "run") {
    if (live.some(p => p.funding === "opening")) reasons.push("opening");
    else if (live.some(p => p.funding === "closing" || p.scheduling === "draining")) reasons.push("settling");
    else reasons.push("awaiting-resources");
  }
  const recent = s.actualSamples.filter(x => x.end > s.now - s.config.sampleWindowMs);
  const start = Math.max(s.now - s.config.sampleWindowMs, Math.min(s.now, ...recent.map(x => x.start)));
  const bytes = recent.reduce((n, x) => n + x.bytes * (x.end - Math.max(start, x.start)) / (x.end - x.start), 0);
  let costMin = 0n, costMax = 0n, covered = true;
  for (const item of pendingContent(s)) {
    const request = Object.values(s.requests).find(r => ["pending", "unresolved"].includes(r.state) && r.contentIds.includes(item.id));
    const prices = request ? [sats(request.prices[item.id])] : rec.quotes
      .filter(q => !q.contentIds || q.contentIds.includes(item.id)).map(q => price(q, item));
    if (!prices.length) { covered = false; break; }
    costMin += prices.reduce((a, b) => a < b ? a : b);
    costMax += prices.reduce((a, b) => a > b ? a : b);
  }
  const online = Object.values(s.sellers).filter(x => x.online && x.quote
    && (x.evictedVersion ?? 0) < x.quote.version);
  const aboveCeiling = online.filter(x => sats(x.quote!.blockPrice) > rec.effective).length;
  const eligibleIds = new Set(rec.quotes.map(q => q.sellerId));
  const measured = Object.values(s.sellers).filter(x => sellerSpeed(s, x.id) !== null).length;
  const unmeasuredEligible = rec.quotes.filter(q => sellerSpeed(s, q.sellerId) === null).length;
  return {
    taskId: s.taskId, revision: s.revision,
    execution: complete ? "finished" : s.intent === "ready" ? "ready"
      : s.intent === "cancel" ? (requests.length ? "stopping" : "stopped")
      : s.intent === "pause" ? (requests.length ? "stopping" : "paused")
      : requests.length ? "running" : "waiting",
    content: !s.manifestKnown ? "manifest-unknown" : complete ? "complete" : "incomplete",
    funds: live.some(p => p.funding === "recovery") ? "recovery-required"
      : live.length || pools.some(p => p.funding === "closed" && !p.refundAvailable) ? "pending"
      : pools.length ? "settled" : "none",
    price: rec.price,
    sellerSpeeds: Object.fromEntries(Object.values(s.sellers).map(x => [x.id, {
      bytesPerSecond: sellerSpeed(s, x.id), samples: x.samples.length, lastAt: x.samples.at(-1)?.end ?? null,
    }])),
    actualBytesPerSecond: s.now > start ? bytes * 1000 / (s.now - start) : 0,
    sustainableBytesPerSecond: sustainable,
    facts: {
      eligible: eligibleIds.size, aboveCeiling, measured,
      unmeasuredEligible, inFlight: requests.length,
    },
    completed: Object.keys(s.completed).length, total: Object.keys(s.content).length, reasons,
    money: {
      spent: s.spent,
      locked: String(live.reduce((n, p) => n + sats(p.amount), 0n)),
      committed: String(live.reduce((n, p) => n + sats(p.committed), 0n)),
      pendingReturn: String(pools.filter(p => p.funding === "closed" && !p.refundAvailable)
        .reduce((n, p) => n + sats(p.returned ?? "0"), 0n)),
      arbitrationReserved: String(live.reduce((n, p) => n + sats(p.fees.arbitrationBase)
        + sats(p.fees.arbitrationPerItem) * BigInt(p.requestId ? s.requests[p.requestId].contentIds.length : 1), 0n)),
      settlementReserved: String(live.reduce((n, p) => n + sats(p.fees.settlement), 0n)),
    },
    estimatedRemainingContent: covered && s.manifestKnown ? { min: String(costMin), max: String(costMax) } : null,
  };
}
