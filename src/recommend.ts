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
/** 可用集合包含仍有效的旧池锁价合同，即使原报价已经过期。 */
export function candidates(s: State): Quote[] {
  return Object.values(s.sellers).filter(x => x.online && x.blockedUntil <= s.now).flatMap(seller => {
    const pool = Object.values(s.pools).find(p => p.sellerId === seller.id
      && ["open", "opening"].includes(p.funding) && p.scheduling !== "draining");
    const q = pool?.quote ?? seller.quote;
    return q && (pool || q.expiresAt > s.now) && sats(q.blockPrice) <= sats(s.config.maxBlockPrice)
      && availableContent(s, q).length ? [q] : [];
  });
}
const byPrice = (a: Quote, b: Quote) => sats(a.blockPrice) < sats(b.blockPrice) ? -1
  : sats(a.blockPrice) > sats(b.blockPrice) ? 1 : a.sellerId.localeCompare(b.sellerId);

export function totalSpeed(s: State, quotes: Quote[]): number {
  const values = [...new Set(quotes.map(q => q.sellerId))].map(id => sellerSpeed(s, id) ?? 0)
    .sort((a, b) => b - a).slice(0, s.config.maxPools);
  return Math.min(values.reduce((a, b) => a + b, 0), s.config.receiveBytesPerSecond ?? Infinity);
}

export function recommendations(s: State): { price: SliderView; speed: SliderView; quotes: Quote[] } {
  const quotes = candidates(s).sort(byPrice);
  const ceiling = s.price.mode === "manual" ? sats(s.price.manualValue!) : sats(s.config.maxBlockPrice);
  let recommendedPrice: string | null = null;
  if (quotes.length) {
    if (s.speed.mode === "manual") {
      const target = Number(s.speed.manualValue);
      recommendedPrice = quotes.at(-1)!.blockPrice;
      for (const q of quotes) {
        if (totalSpeed(s, quotes.filter(x => sats(x.blockPrice) <= sats(q.blockPrice))) >= target) {
          recommendedPrice = q.blockPrice; break;
        }
      }
    } else recommendedPrice = s.preference === "price" ? quotes[0].blockPrice : quotes.at(-1)!.blockPrice;
  }
  const effectivePrice = s.price.mode === "manual" ? s.price.manualValue : recommendedPrice;
  const eligible = quotes.filter(q => sats(q.blockPrice) <= (effectivePrice === null ? ceiling : sats(effectivePrice)));
  const measured = totalSpeed(s, eligible);
  const recommendedSpeed = eligible.some(q => sellerSpeed(s, q.sellerId) !== null) ? String(Math.floor(measured)) : null;
  return {
    price: { ...s.price, recommended: recommendedPrice, effective: effectivePrice,
      range: quotes.length ? { min: quotes[0].blockPrice, max: quotes.at(-1)!.blockPrice } : null },
    speed: { ...s.speed, recommended: recommendedSpeed,
      effective: s.speed.mode === "manual" ? s.speed.manualValue : recommendedSpeed,
      range: recommendedSpeed === null ? null : { min: "0", max: recommendedSpeed } },
    quotes: eligible,
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
  if (rec.speed.effective !== null && totalSpeed(s, rec.quotes) < Number(rec.speed.effective)) reasons.push("speed-target-unreachable");
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
  const remainingBytes = pendingContent(s).reduce((n, x) => n + x.bytes, 0);
  let costMin = 0n, costMax = 0n, covered = true;
  for (const item of pendingContent(s)) {
    const request = Object.values(s.requests).find(r => ["pending", "unresolved"].includes(r.state) && r.contentIds.includes(item.id));
    const prices = request ? [sats(request.prices[item.id])] : rec.quotes
      .filter(q => !q.contentIds || q.contentIds.includes(item.id)).map(q => price(q, item));
    if (!prices.length) { covered = false; break; }
    costMin += prices.reduce((a, b) => a < b ? a : b);
    costMax += prices.reduce((a, b) => a > b ? a : b);
  }
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
    price: rec.price, speed: rec.speed,
    sellerSpeeds: Object.fromEntries(Object.values(s.sellers).map(x => [x.id, {
      bytesPerSecond: sellerSpeed(s, x.id), samples: x.samples.length, lastAt: x.samples.at(-1)?.end ?? null,
    }])),
    actualBytesPerSecond: s.now > start ? bytes * 1000 / (s.now - start) : 0,
    sustainableBytesPerSecond: sustainable,
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
    estimatedRemainingSeconds: sustainable > 0 ? remainingBytes / sustainable : null,
    estimatedRemainingContent: covered && s.manifestKnown ? { min: String(costMin), max: String(costMax) } : null,
  };
}

