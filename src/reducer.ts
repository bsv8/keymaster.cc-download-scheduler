import { identity, integer, price, sats, validateFees, validateQuote, contentBytes } from "./math.js";
import { deriveFileInfo, parseFileInfo, sameManifest } from "./manifest.js";
import type { Event, Seller, State } from "./types.js";

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

/** 登记 Seed（无字节数）；每个任务恰好一个，id 等于 seedHash。 */
export function registerSeed(s: State) {
  s.content[s.seedHash] = { id: s.seedHash, kind: "seed" };
}

/**
 * 追加复用块（可重复调用）：不能覆盖购买记录、不能解除未决认领。
 * 已 purchased 的块保持 purchased；已 reused 的块不变。
 */
export function markReused(s: State, reused: string[], blocks: Map<string, number>) {
  const unique = [...new Set(reused)];
  for (const id of unique) {
    if (!blocks.has(id)) throw new Error("Unknown reused content");
  }
  for (const id of unique) {
    if (Object.values(s.requests).some(r => ["planned", "pending", "unresolved"].includes(r.state) && r.contentIds.includes(id))) {
      throw new Error("Reusing unresolved content");
    }
  }
  for (const id of unique) {
    if (s.completed[id] === "purchased") continue;
    s.completed[id] ??= "reused";
  }
}

/** 已校验的文件信息写入状态：登记唯一块、标记复用块、记录清单。 */
export function applyFileInfo(s: State, derived: ReturnType<typeof deriveFileInfo>, reused: string[] = []) {
  for (const [id, bytes] of derived.blocks) {
    const old = s.content[id];
    if (old) {
      if (old.kind !== "block" || old.bytes !== bytes) throw new Error("Conflicting content identity");
      continue;
    }
    s.content[id] = { id, kind: "block", bytes };
  }
  markReused(s, reused, derived.blocks);
  s.manifest = { fileBytes: derived.manifest.fileBytes, blockBytes: derived.manifest.blockBytes, blockHashes: [...derived.manifest.blockHashes] };
}

export function reduce(s: State, e: Event) {
  switch (e.type) {
    case "start": case "resume":
      if (s.intent !== "cancel") {
        s.intent = "run";
        if (e.type === "resume" && s.quoteDiscovery && !s.quoteDiscovery.pendingCommandId) {
          s.quoteDiscovery.requested = false; s.quoteDiscovery.failed = false;
        }
      }
      break;
    case "quote-source":
      if (typeof e.enabled !== "boolean") throw new Error("Missing quote source capability");
      s.quoteDiscovery ??= { enabled: false, armed: false, requested: false, failed: false, pendingCommandId: null };
      s.quoteDiscovery.enabled = e.enabled;
      break;
    case "quotes-requested": case "quotes-request-failed":
      if (s.quoteDiscovery?.pendingCommandId === e.commandId) {
        s.quoteDiscovery.pendingCommandId = null;
        s.quoteDiscovery.failed = e.type === "quotes-request-failed";
        if (s.quoteDiscovery.failed) s.quoteDiscovery.armed = false;
      }
      break;
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
    case "manifest": {
      if (e.fileBytes === undefined || e.blockBytes === undefined || !Array.isArray(e.blockHashes)) throw new Error("Invalid manifest");
      const parsed = parseFileInfo(s.seedHash, e);
      if (!parsed) throw new Error("Invalid manifest");
      if (s.manifest) {
        // 清单（含顺序与重复次数）一旦确定不得变更；相同信息重复提供时只允许追加合法复用块。
        if (!sameManifest(s.manifest, parsed.derived.manifest)) throw new Error("Conflicting manifest");
        markReused(s, parsed.reused, parsed.derived.blocks);
        break;
      }
      applyFileInfo(s, parsed.derived, parsed.reused);
      break;
    }
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
    case "fees": {
      validateFees(e.fees);
      const pool = s.pools[e.poolId];
      if (!pool) throw new Error("Unknown fee contract");
      if (e.fees.version > pool.fees.version) pool.fees = { ...e.fees };
      break;
    }
    case "pool-available": {
      identity(e.poolId); identity(e.sellerId); identity(e.sessionId);
      sats(e.amount); sats(e.committed); validateFees(e.fees);
      if (sats(e.committed) > sats(e.amount)) throw new Error("Corrupt pool commitment");
      const old = s.pools[e.poolId];
      if (old) {
        if (old.sellerId !== e.sellerId || old.sessionId !== e.sessionId || old.amount !== e.amount || old.committed !== e.committed) throw new Error("Conflicting pool observation");
        break;
      }
      ensureSeller(s, e.sellerId, true);
      s.pools[e.poolId] = { id: e.poolId, taskId: s.taskId, sellerId: e.sellerId, sessionId: e.sessionId,
        openingFee: "0", fees: { ...e.fees }, amount: e.amount, committed: e.committed,
        blockCapacity: 0, purchasedBlocks: 0, funding: "open", scheduling: "idle",
        openCommandId: "", closeCommandId: null, requestId: null, drainReason: null,
        returned: null, refundAvailable: false, openingObserved: true };
      break;
    }
    case "opened": {
      const p = s.pools[e.poolId];
      if (!p || p.openCommandId !== e.commandId) throw new Error("Uncorrelated opening");
      if (p.openingObserved) break;
      if (!["opening", "problem"].includes(p.funding)) break;
      p.openingObserved = true;
      s.spent = String(sats(s.spent) + sats(p.openingFee));
      // 晚到的可信事实照常记录；problem 池不因此回到调度。
      if (p.funding === "opening") p.funding = "open";
      break;
    }
    case "open-failed": {
      const p = s.pools[e.poolId];
      if (!p || p.openCommandId !== e.commandId) throw new Error("Uncorrelated failure");
      if (p.openingObserved || !["opening", "problem"].includes(p.funding)) break;
      p.funding = e.released ? "failed" : "problem";
      if (e.insufficientFunds) s.failure ??= {code: "insufficient-funds", sellerId: p.sellerId, required: String(sats(p.amount) + sats(p.openingFee))};
      const work = p.requestId ? s.requests[p.requestId] : undefined;
      // 开池未知没有发出内容授权，计划工作可以解除，资金责任仍保留。
      if (work?.state === "planned") { work.state = "rejected"; p.requestId = null; }
      p.scheduling = "retired"; break;
    }
    case "unknown": {
      const p = s.pools[e.poolId];
      if (!p) throw new Error("Unknown pool result");
      const request = Object.values(s.requests).find(r => r.poolId === p.id && r.commandId === e.commandId);
      if (request && ["settled", "rejected"].includes(request.state) && e.commandId !== p.openCommandId) break;
      if (e.commandId === p.openCommandId && p.openingObserved) break;
      if (![p.openCommandId, p.closeCommandId, request?.commandId].includes(e.commandId)) throw new Error("Uncorrelated unknown result");
      if (["closed", "failed", "problem"].includes(p.funding)) break;
      // 结果未知就是错误：池移出调度进问题池，等事后清理，不自动查链、不自动重试。
      if (request?.state === "planned") { request.state = "rejected"; p.requestId = null; }
      else if (request) request.state = "unresolved";
      p.funding = "problem"; p.scheduling = "retired";
      break;
    }
    case "progress": {
      identity(e.requestId);
      const r = s.requests[e.requestId];
      if (!r || r.state !== "pending") break;
      integer(e.bytes);
      const items = r.contentIds.map(id => s.content[id]);
      // Seed 字节未知：只跳过上限校验，进度推进与停摆判定照旧。
      if (items.every(item => item.bytes !== undefined)) {
        const size = items.reduce((n, item) => n + contentBytes(item), 0);
        if (e.bytes > size) throw new Error("Impossible transfer progress");
      }
      if (e.bytes > r.transferredBytes) { r.transferredBytes = e.bytes; r.lastProgressAt = s.now; }
      break;
    }
    case "delivery": {
      identity(e.requestId);
      const r = s.requests[e.requestId];
      if (!r) throw new Error("Unknown delivery request");
      if (r.state === "settled") break;
      if (!["pending", "unresolved"].includes(r.state)) throw new Error("Delivery without outstanding purchase authorization");
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
      const bytes = e.accepted.filter(id => s.content[id].kind === "block").reduce((n, id) => n + contentBytes(s.content[id]), 0);
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
      if (!e.safeToRetry) {
        // 不可安全重试不是“卖家有错”的证据，更不能释放已发授权。
        r.state = "unresolved"; p.funding = "problem"; p.scheduling = "retired";
      } else {
        r.state = "rejected"; p.requestId = null;
        if (p.scheduling !== "retired") { p.scheduling = "draining"; p.drainReason = "request-rejected"; }
      }
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
    for (const id of r.contentIds) if (sats(r.prices[id]) !== price(r.quote, s.content[id])) throw new Error("Corrupt request prices");
  }
}
