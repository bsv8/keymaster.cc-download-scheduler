import { identity, integer, price, sats, validateFees, validateQuote } from "./math.js";
import type { Content, Event, Seller, State } from "./types.js";

function ensureSeller(s: State, id: string, online: boolean): Seller {
  return s.sellers[id] ??= {
    id, online, quote: null, bytesTotal: 0, timeMsTotal: 0,
    measured: false, lastAt: null, blacklisted: false, failureCount: 0,
  };
}

/** 记录一次失败尝试的已传字节与耗时：零字节尝试保持 0 速，与未测速分开。 */
export function recordFailedAttempt(seller: Seller, bytes: number, startedAt: number, at: number) {
  seller.bytesTotal += bytes;
  seller.timeMsTotal += Math.max(1, at - startedAt);
  seller.measured = true; seller.lastAt = at;
}

export function addContent(s: State, content: Content[], reused: string[] = []) {
  for (const c of content) {
    identity(c.id);
    if (!["seed", "block"].includes(c.kind)) throw new Error("Invalid content");
    integer(c.bytes, 1);
    const old = s.content[c.id];
    if (old && (old.bytes !== c.bytes || old.kind !== c.kind)) throw new Error("Conflicting content identity");
    s.content[c.id] = { ...c };
  }
  if (Object.values(s.content).filter(c => c.kind === "seed").length > 1) throw new Error("Multiple Seed objects");
  for (const id of reused) {
    if (!s.content[id]) throw new Error("Unknown reused content");
    if (Object.values(s.requests).some(r => ["pending", "unresolved"].includes(r.state) && r.contentIds.includes(id))) throw new Error("Reusing unresolved content");
    s.completed[id] ??= "reused";
  }
}

export function reduce(s: State, e: Event) {
  switch (e.type) {
    case "start": case "resume": if (s.intent !== "cancel") s.intent = "run"; break;
    case "pause": if (s.intent !== "cancel") s.intent = "pause"; break;
    case "cancel": s.intent = "cancel"; break;
    case "tick": break;
    case "limits":
      if (e.maxBlockPrice !== undefined) { sats(e.maxBlockPrice); s.config.maxBlockPrice = e.maxBlockPrice; }
      if (e.baseSeats !== undefined) { integer(e.baseSeats, 1); s.config.baseSeats = e.baseSeats; }
      if (e.floatingSeats !== undefined) { integer(e.floatingSeats, 1); s.config.floatingSeats = e.floatingSeats; }
      break;
    case "slider":
      sats(e.value);
      if (e.slider !== "price") throw new Error("Invalid slider");
      s.price = { mode: "manual", manualValue: e.value }; break;
    case "automatic":
      if (e.slider !== "price") throw new Error("Invalid slider");
      s.price.mode = "auto"; break;
    case "manifest": addContent(s, e.content, e.reused); s.manifestKnown = true; break;
    case "quote": {
      validateQuote(e.quote);
      const q = e.quote;
      const seller = ensureSeller(s, q.sellerId, true);
      if (!seller.quote || q.version > seller.quote.version) seller.quote = { ...q };
      break;
    }
    case "seller": {
      identity(e.sellerId);
      ensureSeller(s, e.sellerId, false).online = e.online; break;
    }
    case "wallet":
      integer(e.revision); sats(e.available);
      if (e.revision > s.wallet.revision) s.wallet = { revision: e.revision, available: e.available, reflectedCommands: [...e.reflectedCommands] };
      break;
    case "fees": {
      validateFees(e.fees);
      const pool = s.pools[e.poolId];
      if (!pool) throw new Error("Unknown fee contract");
      if (e.fees.version > pool.fees.version) pool.fees = { ...e.fees };
      break;
    }
    case "opened": {
      const p = s.pools[e.poolId];
      if (!p || p.openCommandId !== e.commandId) throw new Error("Uncorrelated opening");
      if (p.openingObserved) break;
      if (!["opening", "problem"].includes(p.funding)) break;
      p.openingObserved = true;
      s.spent = String(sats(s.spent) + sats(p.quote.fees.opening));
      // 晚到的可信事实照常记录；problem 池不因此回到调度。
      if (p.funding === "opening") p.funding = "open";
      break;
    }
    case "open-failed": {
      const p = s.pools[e.poolId];
      if (!p || p.openCommandId !== e.commandId) throw new Error("Uncorrelated failure");
      if (p.openingObserved || !["opening", "problem"].includes(p.funding)) break;
      p.funding = e.released ? "failed" : "problem";
      p.scheduling = "retired"; break;
    }
    case "unknown": {
      const p = s.pools[e.poolId];
      if (!p) throw new Error("Unknown pool result");
      const request = Object.values(s.requests).find(r => r.poolId === p.id && r.commandId === e.commandId);
      if (request && ["settled", "rejected"].includes(request.state)) break;
      if (e.commandId === p.openCommandId && p.openingObserved) break;
      if (![p.openCommandId, p.closeCommandId, request?.commandId].includes(e.commandId)) throw new Error("Uncorrelated unknown result");
      if (["closed", "failed", "problem"].includes(p.funding)) break;
      // 结果未知就是错误：池移出调度进问题池，等事后清理，不自动查链、不自动重试。
      if (request) request.state = "unresolved";
      p.funding = "problem"; p.scheduling = "retired";
      break;
    }
    case "progress": {
      identity(e.requestId);
      const r = s.requests[e.requestId];
      if (!r || r.state !== "pending") break;
      integer(e.bytes);
      const size = r.contentIds.reduce((n, id) => n + s.content[id].bytes, 0);
      if (e.bytes > size) throw new Error("Impossible transfer progress");
      if (e.bytes > r.transferredBytes) { r.transferredBytes = e.bytes; r.lastProgressAt = s.now; }
      break;
    }
    case "delivery": {
      identity(e.requestId);
      const r = s.requests[e.requestId];
      if (!r) throw new Error("Unknown delivery request");
      if (r.state === "settled") break;
      const p = s.pools[r.poolId];
      if (["closed", "failed"].includes(p.funding)) throw new Error("Delivery after pool settlement");
      integer(e.startedAt); integer(e.endedAt, e.startedAt + 1);
      if (e.endedAt > s.now) throw new Error("Future delivery");
      if (new Set(e.accepted).size !== e.accepted.length || e.accepted.some(id => !r.contentIds.includes(id))) throw new Error("Invalid accepted content");
      const expected = e.accepted.reduce((n, id) => n + sats(r.prices[id]), 0n);
      if (sats(e.paid) !== expected) throw new Error("Payment differs from authorization");
      if (sats(p.committed) + expected > sats(p.amount)) throw new Error("Pool overspend");
      p.committed = String(sats(p.committed) + expected);
      p.purchasedBlocks += e.accepted.filter(id => s.content[id].kind === "block").length;
      s.spent = String(sats(s.spent) + expected);
      r.state = "settled"; p.requestId = null;
      for (const id of e.accepted) s.completed[id] = "purchased";
      const seller = s.sellers[p.sellerId];
      const bytes = e.accepted.filter(id => s.content[id].kind === "block").reduce((n, id) => n + s.content[id].bytes, 0);
      if (!e.accepted.length) {
        // 确定失败：验收为空（坏块 / 内容校验失败）→ 本任务立即拉黑该卖家。
        seller.blacklisted = true; seller.failureCount++;
        recordFailedAttempt(seller, 0, e.startedAt, e.endedAt);
      } else if (bytes > 0) {
        // 累计口径：只统计已验收交付的块字节与墙钟耗时。
        seller.bytesTotal += bytes;
        seller.timeMsTotal += e.endedAt - e.startedAt;
        seller.measured = true; seller.lastAt = e.endedAt;
      }
      if (p.funding === "open" && p.scheduling !== "draining" && p.scheduling !== "retired") p.scheduling = "serving";
      break;
    }
    case "request-rejected": {
      const r = s.requests[e.requestId];
      if (!r || !["pending", "unresolved"].includes(r.state)) break;
      const p = s.pools[r.poolId];
      r.state = "rejected"; p.requestId = null;
      if (!e.safeToRetry) {
        // 不可重试的拒绝是确定失败：本任务立即拉黑该卖家。
        const seller = s.sellers[p.sellerId];
        seller.blacklisted = true; seller.failureCount++;
      }
      if (p.scheduling !== "retired") { p.scheduling = "draining"; p.drainReason = "request-rejected"; }
      break;
    }
    case "closed": {
      const p = s.pools[e.poolId];
      if (!p || p.closeCommandId !== e.commandId || p.requestId) throw new Error("Uncorrelated or unsafe close");
      if (p.funding === "closed") break;
      if (sats(e.returned) + sats(e.spent) + sats(p.committed) !== sats(p.amount)) throw new Error("Close money mismatch");
      p.funding = "closed"; p.scheduling = "retired"; p.returned = e.returned;
      s.spent = String(sats(s.spent) + sats(e.spent)); break;
    }
    case "refund-available": {
      const p = s.pools[e.poolId];
      if (!p || p.funding !== "closed") throw new Error("Refund before close observation");
      p.refundAvailable = true; break;
    }
    default: throw new Error("Unknown scheduler event");
  }
}

export function assertRequestPrices(s: State) {
  for (const r of Object.values(s.requests)) {
    for (const id of r.contentIds) if (sats(r.prices[id]) !== price(s.pools[r.poolId].quote, s.content[id])) throw new Error("Corrupt request prices");
  }
}
