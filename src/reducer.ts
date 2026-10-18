import { identity, integer, price, sats, validateFees, validateQuote } from "./math.js";
import type { Content, Event, State } from "./types.js";

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
      if (e.receiveBytesPerSecond !== undefined) { integer(e.receiveBytesPerSecond, 1); s.config.receiveBytesPerSecond = e.receiveBytesPerSecond; }
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
      const seller = s.sellers[q.sellerId] ??= { id: q.sellerId, online: true, quote: null, samples: [], blockedUntil: 0, blacklisted: false, failureCount: 0, zeroSpeedAt: null };
      if (!seller.quote || q.version > seller.quote.version) seller.quote = { ...q };
      break;
    }
    case "seller": {
      identity(e.sellerId);
      const seller = s.sellers[e.sellerId] ??= { id: e.sellerId, online: false, quote: null, samples: [], blockedUntil: 0, blacklisted: false, failureCount: 0, zeroSpeedAt: null };
      seller.online = e.online; break;
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
      if (!["opening", "recovery"].includes(p.funding)) break;
      p.funding = "open"; p.recoveryCommandId = null;
      if (!p.openingObserved) s.spent = String(sats(s.spent) + sats(p.quote.fees.opening));
      p.openingObserved = true; break;
    }
    case "open-failed": {
      const p = s.pools[e.poolId];
      if (!p || p.openCommandId !== e.commandId) throw new Error("Uncorrelated failure");
      if (p.openingObserved || !["opening", "recovery"].includes(p.funding)) break;
      p.funding = e.released ? "failed" : "recovery";
      p.recoveryAt = s.now;
      s.sellers[p.sellerId].blockedUntil = s.now + s.config.retryMs; break;
    }
    case "unknown": {
      const p = s.pools[e.poolId];
      if (!p) throw new Error("Unknown pool result");
      const request = Object.values(s.requests).find(r => r.poolId === p.id && r.commandId === e.commandId);
      if (request && ["settled", "rejected"].includes(request.state)) break;
      if (e.commandId === p.openCommandId && p.openingObserved) break;
      if (![p.openCommandId, p.closeCommandId, request?.commandId].includes(e.commandId)) throw new Error("Uncorrelated unknown result");
      if (["closed", "failed"].includes(p.funding)) break;
      p.funding = "recovery"; p.recoveryAt = s.now; p.recoveryCommandId = null; break;
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
      if (["settled", "rejected"].includes(r.state)) break;
      integer(e.startedAt); integer(e.endedAt, e.startedAt + 1);
      if (e.endedAt > s.now) throw new Error("Future delivery");
      if (new Set(e.accepted).size !== e.accepted.length || e.accepted.some(id => !r.contentIds.includes(id))) throw new Error("Invalid accepted content");
      const expected = e.accepted.reduce((n, id) => n + sats(r.prices[id]), 0n);
      if (sats(e.paid) !== expected) throw new Error("Payment differs from authorization");
      const p = s.pools[r.poolId];
      if (sats(p.committed) + expected > sats(p.amount)) throw new Error("Pool overspend");
      p.committed = String(sats(p.committed) + expected);
      p.purchasedBlocks += e.accepted.filter(id => s.content[id].kind === "block").length;
      s.spent = String(sats(s.spent) + expected);
      r.state = "settled"; p.requestId = null;
      for (const id of e.accepted) s.completed[id] = "purchased";
      // 确定失败：验收为空（坏块 / 内容校验失败）→ 本任务立即拉黑该卖家。
      if (!e.accepted.length) { s.sellers[p.sellerId].blacklisted = true; s.sellers[p.sellerId].failureCount++; }
      else s.sellers[p.sellerId].zeroSpeedAt = null;
      const bytes = e.accepted.filter(id => s.content[id].kind === "block").reduce((n, id) => n + s.content[id].bytes, 0);
      if (bytes) {
        const sample = { bytes, start: e.startedAt, end: e.endedAt };
        s.sellers[p.sellerId].samples.push(sample); s.actualSamples.push(sample);
      }
      if (p.funding === "recovery") { p.funding = "open"; p.recoveryCommandId = null; }
      if (p.scheduling !== "draining") p.scheduling = "serving";
      break;
    }
    case "request-rejected": {
      const r = s.requests[e.requestId];
      if (!r || !["pending", "unresolved"].includes(r.state)) break;
      const p = s.pools[r.poolId];
      if (e.safeToRetry) {
        r.state = "rejected"; p.requestId = null;
        if (p.funding === "recovery") { p.funding = "open"; p.recoveryCommandId = null; }
        p.scheduling = "draining"; p.drainReason = "request-rejected";
        s.sellers[p.sellerId].blockedUntil = s.now + s.config.retryMs;
      }
      else { r.state = "unresolved"; p.funding = "recovery"; p.recoveryAt = s.now;
        // 不可重试的拒绝是确定失败：本任务立即拉黑该卖家。
        s.sellers[p.sellerId].blacklisted = true; s.sellers[p.sellerId].failureCount++; }
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
    case "reconciled": {
      if (!["close-rejected", "opening-failed"].includes(e.outcome)) throw new Error("Invalid reconciliation outcome");
      const p = s.pools[e.poolId];
      if (!p || p.recoveryCommandId !== e.commandId) throw new Error("Uncorrelated reconciliation");
      if (p.requestId || p.funding !== "recovery") break;
      if (e.outcome === "opening-failed") {
        if (p.openingObserved) throw new Error("Observed opening cannot be erased");
        p.funding = "failed"; s.sellers[p.sellerId].blockedUntil = s.now + s.config.retryMs;
      } else {
        // 开池确认必须通过 `opened` 输入，保证开池费只记一次。
        if (!p.closeCommandId) throw new Error("Use opened result to resolve uncertain opening");
        p.funding = "open"; p.closeCommandId = null;
      }
      p.recoveryCommandId = null; break;
    }
    default: throw new Error("Unknown scheduler event");
  }
  // 按配置时间窗口清理速度样本，保留请求和付款的持久化去重记录。
  for (const seller of Object.values(s.sellers)) seller.samples = seller.samples.filter(x => x.end > s.now - s.config.sampleWindowMs);
  s.actualSamples = s.actualSamples.filter(x => x.end > s.now - s.config.sampleWindowMs);
}

export function assertRequestPrices(s: State) {
  for (const r of Object.values(s.requests)) {
    for (const id of r.contentIds) if (sats(r.prices[id]) !== price(s.pools[r.poolId].quote, s.content[id])) throw new Error("Corrupt request prices");
  }
}
