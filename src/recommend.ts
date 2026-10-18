import { price, sats } from "./math.js";
import type { Quote, SliderView, State, View } from "./types.js";

export function pendingContent(s: State) {
  return Object.values(s.content).filter(c => !s.completed[c.id]);
}
export function availableContent(s: State, q: Quote) {
  return pendingContent(s).filter(c => (!q.contentIds || q.contentIds.includes(c.id))
    && (c.kind === "seed" || !Object.values(s.content).some(x => x.kind === "seed" && !s.completed[x.id])));
}
/**
 * 卖家速度事实：累计已验收交付的块字节 ÷ 累计传输耗时。
 * 长期保留、没有窗口、没有过期；未测速返回 null；测过但零字节返回 0，二者分开。
 */
export function sellerSpeed(s: State, sellerId: string): number | null {
  const seller = s.sellers[sellerId];
  if (!seller || !seller.measured) return null;
  return seller.timeMsTotal > 0 ? seller.bytesTotal * 1000 / seller.timeMsTotal : 0;
}
/** 是否测过速（含零字节的完整尝试）。 */
export function hasArchive(s: State, sellerId: string): boolean {
  return s.sellers[sellerId]?.measured === true;
}
/** 宿主/UI 判断该卖家是否还没有测过速。 */
export function needsProbe(s: State, sellerId: string): boolean {
  return !hasArchive(s, sellerId);
}
/** 任务有效价格上限：手动值优先，否则使用系统缺省值。系统缺省不是授权上限。 */
export function effectivePrice(s: State): bigint {
  return s.price.mode === "manual" && s.price.manualValue !== null
    ? sats(s.price.manualValue) : sats(s.config.maxBlockPrice);
}
/** 在席卖家总数上限。 */
export function seatCap(s: State): number {
  return s.config.baseSeats + s.config.floatingSeats;
}
/** 在席且未测速的卖家上限（浮动位限位）。 */
export function unmeasuredCap(s: State): number {
  return s.config.floatingSeats;
}
/** 市场有效报价：排除黑名单与失去资格的卖家；是否在价格上限内由调用方过滤。 */
export function validQuotes(s: State): Quote[] {
  return Object.values(s.sellers).filter(x => x.online && !x.blacklisted).flatMap(seller => {
    const pool = Object.values(s.pools).find(p => p.sellerId === seller.id
      && ["open", "opening"].includes(p.funding) && p.scheduling !== "draining" && p.scheduling !== "retired");
    const q = pool?.quote ?? seller.quote;
    return q && (pool || q.expiresAt > s.now) && availableContent(s, q).length ? [q] : [];
  });
}
/** 准入集合：市场报价中价格不超过有效上限者。 */
export function candidates(s: State, ceiling: bigint): Quote[] {
  return validQuotes(s).filter(q => sats(q.blockPrice) <= ceiling);
}
export const byPrice = (a: Quote, b: Quote) => sats(a.blockPrice) < sats(b.blockPrice) ? -1
  : sats(a.blockPrice) > sats(b.blockPrice) ? 1 : a.sellerId.localeCompare(b.sellerId);

/** 一组卖家的累计速度合计；没有接收带宽上限参数，只做事实求和。 */
export function totalSpeed(s: State, quotes: Quote[]): number {
  const values = [...new Set(quotes.map(q => q.sellerId))].map(id => sellerSpeed(s, id) ?? 0);
  return values.reduce((a, b) => a + b, 0);
}

/** 价格杆视图：v1 没有自动建议，只有系统缺省值与用户手动值。 */
export function recommendations(s: State): { price: SliderView; quotes: Quote[]; effective: bigint } {
  const effective = effectivePrice(s);
  const market = validQuotes(s).sort(byPrice);
  const quotes = market.filter(q => sats(q.blockPrice) <= effective);
  return {
    price: {
      mode: s.price.mode, manualValue: s.price.manualValue, effective: String(effective),
      range: market.length ? { min: market[0].blockPrice, max: market.at(-1)!.blockPrice } : null,
    },
    quotes, effective,
  };
}

export function view(s: State): View {
  const rec = recommendations(s);
  const pools = Object.values(s.pools);
  const live = pools.filter(p => !["closed", "failed", "problem"].includes(p.funding));
  const problem = pools.filter(p => p.funding === "problem");
  const complete = s.manifestKnown && pendingContent(s).length === 0;
  const requests = Object.values(s.requests).filter(r => r.state === "pending" || r.state === "unresolved");
  const serving = live.filter(p => p.funding === "open" && p.requestId && p.scheduling === "serving");
  const active = live.filter(p => p.funding === "open" && p.scheduling !== "draining" && p.scheduling !== "retired");
  const reasons: string[] = [];
  if (!s.manifestKnown) reasons.push("manifest-unknown");
  if (problem.length) reasons.push("problem-pool");
  if (!rec.quotes.length && !complete) reasons.push("no-eligible-seller");
  if (rec.quotes.some(q => sellerSpeed(s, q.sellerId) === null)) reasons.push("speed-unmeasured");
  if (s.price.mode === "manual" && Object.values(s.sellers).some(x => x.online && !x.blacklisted && x.quote
    && sats(x.quote.blockPrice) > sats(s.price.manualValue!))) reasons.push("price-limit");
  if (!complete && !requests.length && s.intent === "run") {
    if (live.some(p => p.funding === "opening")) reasons.push("opening");
    else if (live.some(p => p.funding === "closing" || p.scheduling === "draining")) reasons.push("settling");
    else reasons.push("awaiting-resources");
  }
  let costMin = 0n, costMax = 0n, covered = true;
  for (const item of pendingContent(s)) {
    const request = Object.values(s.requests).find(r => ["pending", "unresolved"].includes(r.state) && r.contentIds.includes(item.id));
    const prices = request ? [sats(request.prices[item.id])] : rec.quotes
      .filter(q => !q.contentIds || q.contentIds.includes(item.id)).map(q => price(q, item));
    if (!prices.length) { covered = false; break; }
    costMin += prices.reduce((a, b) => a < b ? a : b);
    costMax += prices.reduce((a, b) => a > b ? a : b);
  }
  const online = Object.values(s.sellers).filter(x => x.online && !x.blacklisted && x.quote);
  const aboveCeiling = online.filter(x => sats(x.quote!.blockPrice) > rec.effective).length;
  const eligibleIds = new Set(rec.quotes.map(q => q.sellerId));
  const speeds = Object.values(s.sellers).map(x => [x.id, sellerSpeed(s, x.id)] as const);
  const measured = speeds.filter(([, speed]) => speed !== null).length;
  const zeroSpeed = speeds.filter(([, speed]) => speed === 0).length;
  const unmeasuredEligible = rec.quotes.filter(q => sellerSpeed(s, q.sellerId) === null).length;
  const blacklisted = Object.values(s.sellers).filter(x => x.blacklisted).length;
  return {
    taskId: s.taskId, revision: s.revision,
    execution: complete ? "finished" : s.intent === "ready" ? "ready"
      : s.intent === "cancel" ? (requests.length ? "stopping" : "stopped")
      : s.intent === "pause" ? (requests.length ? "stopping" : "paused")
      : requests.length ? "running" : "waiting",
    content: !s.manifestKnown ? "manifest-unknown" : complete ? "complete" : "incomplete",
    funds: problem.length ? "problem"
      : live.length || pools.some(p => p.funding === "closed" && !p.refundAvailable) ? "pending"
      : pools.length ? "settled" : "none",
    price: rec.price,
    sellerSpeeds: Object.fromEntries(Object.values(s.sellers).map(x => [x.id, {
      bytesPerSecond: sellerSpeed(s, x.id), measured: x.measured,
      bytesTotal: x.bytesTotal, timeMsTotal: x.timeMsTotal, lastAt: x.lastAt,
    }])),
    actualBytesPerSecond: totalSpeed(s, serving.map(p => p.quote)),
    sustainableBytesPerSecond: totalSpeed(s, active.map(p => p.quote)),
    facts: {
      eligible: eligibleIds.size, aboveCeiling, measured,
      unmeasuredEligible, zeroSpeed, blacklisted, inFlight: requests.length,
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
