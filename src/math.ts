import type { Content, Fees, Quote, Sats, Sample } from "./types.js";

export function sats(value: Sats): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid integer sats");
  return BigInt(value);
}
export function integer(value: number, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error("Invalid integer quantity");
  return value;
}
export function identity(value: string): string {
  if (typeof value !== "string" || !value || value === "prototype" || Object.hasOwn(Object.prototype, value)) throw new Error("Invalid identity");
  return value;
}
export function reserve(fees: Fees, count: number): bigint {
  return sats(fees.settlement) + sats(fees.arbitrationBase) + sats(fees.arbitrationPerItem) * BigInt(count);
}
export function price(quote: Quote, content: Content): bigint {
  if (content.kind === "seed") return sats(quote.seedPrice);
  if (content.bytes < quote.blockBytes && quote.tailPrice !== undefined) return sats(quote.tailPrice);
  // 报价声明完整块大小；尾块按字节比例进行整数向上取整。
  return (sats(quote.blockPrice) * BigInt(content.bytes) + BigInt(quote.blockBytes) - 1n) / BigInt(quote.blockBytes);
}
export function validateFees(f: Fees) {
  integer(f.version); sats(f.opening); sats(f.settlement); sats(f.arbitrationBase); sats(f.arbitrationPerItem);
}
export function validateQuote(q: Quote) {
  identity(q.id); identity(q.sellerId); identity(q.sessionId);
  for (const id of q.contentIds ?? []) identity(id);
  integer(q.version); integer(q.expiresAt); integer(q.blockBytes, 1);
  integer(q.minBlocks, 1); integer(q.maxBlocks, q.minBlocks);
  sats(q.blockPrice); sats(q.seedPrice);
  if (q.tailPrice !== undefined) sats(q.tailPrice);
  validateFees(q.fees);
}
/** 按窗口裁剪有效字节与耗时，不对不同块速率做无权平均。 */
export function rate(samples: Sample[], now: number, window: number, maxAge: number): number | null {
  const recent = samples.filter(s => s.end > now - window && s.end <= now);
  if (!recent.length || now - recent[recent.length - 1].end > maxAge) return null;
  let bytes = 0, time = 0;
  for (const s of recent) {
    const duration = s.end - s.start;
    const overlap = s.end - Math.max(s.start, now - window);
    bytes += s.bytes * overlap / duration;
    time += overlap;
  }
  return time > 0 ? bytes * 1000 / time : null;
}
