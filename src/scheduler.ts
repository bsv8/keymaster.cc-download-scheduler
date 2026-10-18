import { identity, integer, price, reserve, sats, validateFees, validateQuote } from "./math.js";
import { addContent, assertRequestPrices, reduce } from "./reducer.js";
import { availableContent, pendingContent, recommendations, sellerSpeed, totalSpeed, view } from "./recommend.js";
import type { Command, Config, Content, Event, Pool, Quote, Result, State } from "./types.js";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateConfig(c: Config) {
  sats(c.maxBlockPrice); sats(c.maxTotalSpend);
  for (const value of [c.maxPools, c.poolBlocks, c.batchBlocks, c.sampleWindowMs,
    c.sampleMaxAgeMs, c.requestTimeoutMs, c.recoveryRetryMs, c.retryMs]) integer(value, 1);
  if (c.receiveBytesPerSecond !== undefined) integer(c.receiveBytesPerSecond, 1);
}
export function createTask(input: {
  taskId: string; seedHash: string; config: Config; content: Content[];
  manifestKnown: boolean; reused?: string[]; preference?: "price" | "speed";
}): State {
  identity(input.taskId); identity(input.seedHash);
  validateConfig(input.config);
  const state: State = {
    version: 1, taskId: input.taskId, seedHash: input.seedHash, revision: 0, sequence: 0, now: 0,
    config: clone(input.config), preference: input.preference ?? "price", intent: "ready",
    price: { mode: "auto", manualValue: null }, speed: { mode: "auto", manualValue: null },
    manifestKnown: input.manifestKnown, content: {}, completed: {}, sellers: {}, pools: {}, requests: {},
    wallet: { revision: -1, available: "0", reflectedCommands: [] }, spent: "0", actualSamples: [], seenEvents: {},
  };
  addContent(state, input.content, input.reused);
  return state;
}

/** 显式恢复快照；重放输入不会重新发出已经持久化的执行意图。 */
export function restoreTask(snapshot: State): State {
  const s = clone(snapshot);
  if (s.version !== 1 || !s.taskId || !s.seedHash) throw new Error("Unsupported task snapshot");
  validateConfig(s.config); integer(s.now); integer(s.revision); integer(s.sequence);
  identity(s.taskId); identity(s.seedHash);
  if (!["ready", "run", "pause", "cancel"].includes(s.intent) || !["price", "speed"].includes(s.preference)) throw new Error("Invalid snapshot intent");
  sats(s.spent); sats(s.wallet.available);
  for (const slider of [s.price, s.speed]) {
    if (!["auto", "manual"].includes(slider.mode)) throw new Error("Invalid snapshot slider");
    if (slider.manualValue !== null) sats(slider.manualValue);
    if (slider.mode === "manual" && slider.manualValue === null) throw new Error("Missing manual target");
  }
  for (const [key, c] of Object.entries(s.content)) if (key !== c.id) throw new Error("Content key mismatch");
  addContent(s, Object.values(s.content));
  for (const id of Object.keys(s.completed)) if (!s.content[id]) throw new Error("Unknown completed content");
  for (const [id, seller] of Object.entries(s.sellers)) {
    identity(id);
    if (id !== seller.id) throw new Error("Seller key mismatch");
    if (seller.quote) { validateQuote(seller.quote); if (seller.quote.sellerId !== id) throw new Error("Quote seller mismatch"); }
    for (const sample of seller.samples) {
      integer(sample.start); integer(sample.end, sample.start + 1); integer(sample.bytes, 1);
      if (sample.end > s.now) throw new Error("Future speed sample");
    }
  }
  for (const p of Object.values(s.pools)) {
    if (p.taskId !== s.taskId) throw new Error("Cross-task pool snapshot");
    validateQuote(p.quote); validateFees(p.fees);
    if (!s.sellers[p.sellerId] || p.quote.sellerId !== p.sellerId) throw new Error("Missing pool seller");
    if (!["opening", "open", "closing", "closed", "failed", "recovery"].includes(p.funding)) throw new Error("Invalid funding state");
    integer(p.blockCapacity); integer(p.purchasedBlocks);
    if (p.purchasedBlocks > p.blockCapacity) throw new Error("Pool block capacity exceeded");
    sats(p.amount); sats(p.committed);
    if (sats(p.committed) > sats(p.amount)) throw new Error("Corrupt pool commitment");
    if (p.requestId && !s.requests[p.requestId]) throw new Error("Missing unresolved request");
  }
  const claims = new Set<string>();
  for (const r of Object.values(s.requests)) {
    if (!s.pools[r.poolId] || r.contentIds.some(id => !s.content[id])) throw new Error("Orphan request");
    if (new Set(r.contentIds).size !== r.contentIds.length) throw new Error("Duplicate request content");
    if (["pending", "unresolved"].includes(r.state)) {
      if (s.pools[r.poolId].requestId !== r.id) throw new Error("Request ownership mismatch");
      for (const id of r.contentIds) { if (claims.has(id) || s.completed[id]) throw new Error("Duplicate outstanding content"); claims.add(id); }
    }
  }
  assertRequestPrices(s);
  return s;
}

function nextId(s: State, kind: string) { return `${s.taskId}/${kind}/${++s.sequence}`; }
function base(s: State, reason: string) {
  return { commandId: nextId(s, "command"), taskId: s.taskId, revision: s.revision, reason };
}
function live(p: Pool) { return !["closed", "failed"].includes(p.funding); }
function drain(s: State, p: Pool, commands: Command[], reason: string) {
  if (p.scheduling === "draining" || p.scheduling === "retired") return;
  p.scheduling = "draining"; p.drainReason = reason;
  commands.push({ ...base(s, reason), type: "drain", poolId: p.id });
}
function walletFree(s: State): bigint {
  // 无关的钱包修订号更新，不能证明本地资金占用已反映到快照。
  const unreflected = Object.values(s.pools).filter(p => p.funding !== "failed"
    && !s.wallet.reflectedCommands.includes(p.openCommandId))
    .reduce((n, p) => n + sats(p.amount) + sats(p.quote.fees.opening), 0n);
  return sats(s.wallet.available) - unreflected;
}
function authorizedFree(s: State): bigint {
  const outstanding = Object.values(s.pools).filter(live).reduce((n, p) => n + sats(p.amount) - sats(p.committed)
    + (!p.openingObserved ? sats(p.quote.fees.opening) : 0n), 0n);
  return sats(s.config.maxTotalSpend) - sats(s.spent) - outstanding;
}

function choose(s: State, quotes: Quote[], target: number | null): Quote[] {
  const known = quotes.filter(q => sellerSpeed(s, q.sellerId) !== null);
  const unknown = quotes.filter(q => sellerSpeed(s, q.sellerId) === null);
  const fast = (a: Quote, b: Quote) => (sellerSpeed(s, b.sellerId) ?? 0) - (sellerSpeed(s, a.sellerId) ?? 0)
    || a.sellerId.localeCompare(b.sellerId);
  const selected = known.sort(fast).slice(0, s.config.maxPools);
  if (target !== null) {
    // 按用户确定的语义从最慢卖家开始退出，不按价格改变退出顺序。
    for (const q of [...selected].reverse()) {
      const without = selected.filter(x => x.sellerId !== q.sellerId);
      if (totalSpeed(s, without) >= target) selected.splice(selected.indexOf(q), 1);
      else break;
    }
  }
  // 已测卖家占满并发名额，也不能永久阻止新卖家进入探测。
  // 轮换一个慢速名额来探测真实所需块；退出前仍须处理在途责任。
  if (unknown.length && selected.length === s.config.maxPools) selected.pop();
  // 用真实所需内容探测未知卖家，不预设虚构速度。
  for (const q of unknown) if (selected.length < s.config.maxPools) selected.push(q);
  return selected;
}

function plan(s: State): Command[] {
  const commands: Command[] = [];
  for (const r of Object.values(s.requests)) {
    if (r.state === "pending" && s.now >= r.lastProgressAt + s.config.requestTimeoutMs) {
      r.state = "unresolved";
      const p = s.pools[r.poolId]; p.funding = "recovery"; p.recoveryAt = s.now;
    }
  }
  for (const p of Object.values(s.pools)) if (p.funding === "recovery" && p.recoveryAt <= s.now) {
    const command: Command = { ...base(s, "unknown-execution-result"), type: "reconcile", poolId: p.id, requestId: p.requestId };
    p.recoveryCommandId = command.commandId; p.recoveryAt = s.now + s.config.recoveryRetryMs;
    commands.push(command);
  }
  const rec = recommendations(s);
  const complete = s.manifestKnown && pendingContent(s).length === 0;
  const enabled = s.intent === "run" && !complete;
  const awaitingManifest = !s.manifestKnown && pendingContent(s).length === 0;
  const selected = enabled ? choose(s, rec.quotes, rec.speed.effective === null ? null : Number(rec.speed.effective)) : [];
  const selectedIds = new Set(selected.map(q => q.sellerId));
  for (const p of Object.values(s.pools).filter(live)) {
    if (!enabled || (!selectedIds.has(p.sellerId) && !awaitingManifest)) {
      drain(s, p, commands, complete ? "content-complete" : !enabled ? s.intent : "strategy-change");
    }
  }
  const claimed = new Set(Object.values(s.requests).filter(r => ["pending", "unresolved"].includes(r.state)).flatMap(r => r.contentIds));
  for (const p of Object.values(s.pools)) {
    if (p.funding !== "open" || p.requestId) continue;
    if (awaitingManifest && enabled && p.scheduling !== "draining") continue;
    if (p.scheduling !== "draining" && enabled) {
      // 锁价合同可以在原报价过期后继续使用；新请求仍受当前有效价格上限约束。
      const underPrice = rec.price.effective !== null && sats(p.quote.blockPrice) <= sats(rec.price.effective)
        && sats(p.quote.blockPrice) <= sats(s.config.maxBlockPrice);
      if (!underPrice) {
        drain(s, p, commands, "price-limit");
        const command: Command = { ...base(s, "price-limit"), type: "close", poolId: p.id, committed: p.committed };
        p.funding = "closing"; p.closeCommandId = command.commandId;
        p.recoveryAt = s.now + s.config.requestTimeoutMs; commands.push(command); continue;
      }
      let items = availableContent(s, p.quote).filter(c => !claimed.has(c.id));
      const limit = sellerSpeed(s, p.sellerId) === null || items[0]?.kind === "seed" ? 1 : s.config.batchBlocks;
      items = items.slice(0, items[0]?.kind === "seed" ? 1 : Math.min(limit, p.blockCapacity - p.purchasedBlocks));
      while (items.length && items.reduce((n, c) => n + price(p.quote, c), 0n)
        + reserve(p.fees, items.length) > sats(p.amount) - sats(p.committed)) items.pop();
      if (!items.length && availableContent(s, p.quote).some(c => !claimed.has(c.id))) drain(s, p, commands, "pool-capacity");
      if (items.length) {
        const requestId = nextId(s, "request");
        const prices = Object.fromEntries(items.map(c => [c.id, String(price(p.quote, c))]));
        const command: Command = { ...base(s, sellerSpeed(s, p.sellerId) === null ? "probe-real-content" : "continue"),
          type: "download", poolId: p.id, requestId, contentIds: items.map(c => c.id), prices,
          maxPayment: String(Object.values(prices).reduce((n, v) => n + sats(v), 0n)),
          priceLimit: rec.price.effective!, feeVersion: p.fees.version };
        s.requests[requestId] = { id: requestId, commandId: command.commandId, poolId: p.id,
          contentIds: command.contentIds, prices, startedAt: s.now, lastProgressAt: s.now,
          transferredBytes: 0, state: "pending" };
        p.requestId = requestId; p.scheduling = command.reason === "probe-real-content" ? "probing" : "serving";
        for (const c of items) claimed.add(c.id);
        commands.push(command);
      }
    }
    if (p.scheduling === "draining" && !p.requestId) {
      const command: Command = { ...base(s, p.drainReason ?? "drain-complete"), type: "close", poolId: p.id, committed: p.committed };
      p.funding = "closing"; p.closeCommandId = command.commandId;
      p.recoveryAt = s.now + s.config.requestTimeoutMs; commands.push(command);
    }
  }
  if (!enabled) return commands;
  for (const q of selected) {
    const pools = Object.values(s.pools).filter(live);
    if (pools.length >= s.config.maxPools || pools.some(p => p.sellerId === q.sellerId)) continue;
    const seller = s.sellers[q.sellerId];
    const newQuote = seller.quote;
    if (!newQuote || newQuote.expiresAt <= s.now || newQuote.id !== q.id || newQuote.version !== q.version) continue;
    const items = pendingContent(s).filter(c => !claimed.has(c.id) && (!q.contentIds || q.contentIds.includes(c.id)));
    if (!items.length) continue;
    const blocks = items.filter(c => c.kind === "block");
    const seeds = items.filter(c => c.kind === "seed");
    let count = Math.min(blocks.length, q.maxBlocks, s.config.poolBlocks);
    if (blocks.length && count < q.minBlocks) continue;
    const money = walletFree(s) < authorizedFree(s) ? walletFree(s) : authorizedFree(s);
    let budget = 0n, amount = 0n;
    while (count >= (blocks.length ? q.minBlocks : 0)) {
      budget = [...seeds, ...blocks.slice(0, count)].reduce((n, c) => n + price(q, c), 0n);
      amount = budget + reserve(q.fees, Math.max(1, Math.min(s.config.batchBlocks, count || 1)));
      if (amount + sats(q.fees.opening) <= money) break;
      count--;
    }
    if (count < (blocks.length ? q.minBlocks : 0)) continue;
    const poolId = nextId(s, "pool");
    const command: Command = { ...base(s, "selected-seller"), type: "open", poolId,
      sellerId: q.sellerId, sessionId: q.sessionId, quote: clone(q), amount: String(amount),
      contentBudget: String(budget), reserve: String(amount - budget), openingFee: q.fees.opening,
      walletRevision: s.wallet.revision, blockCapacity: count };
    s.pools[poolId] = {
      id: poolId, taskId: s.taskId, sellerId: q.sellerId, sessionId: q.sessionId,
      quote: clone(q), fees: clone(q.fees), amount: command.amount, committed: "0", blockCapacity: count, purchasedBlocks: 0,
      funding: "opening", scheduling: "idle", openCommandId: command.commandId,
      closeCommandId: null, requestId: null, drainReason: null, returned: null,
      refundAvailable: false, openingObserved: false, recoveryAt: s.now + s.config.requestTimeoutMs,
      recoveryCommandId: null, walletRevisionAtIntent: s.wallet.revision,
    };
    commands.push(command);
  }
  return commands;
}

function nextWakeAt(s: State): number | null {
  const times: number[] = [];
  for (const seller of Object.values(s.sellers)) {
    if (seller.quote && seller.quote.expiresAt > s.now) times.push(seller.quote.expiresAt);
    if (seller.blockedUntil > s.now) times.push(seller.blockedUntil);
    const sample = seller.samples.at(-1);
    if (sample && sample.end + s.config.sampleMaxAgeMs + 1 > s.now) times.push(sample.end + s.config.sampleMaxAgeMs + 1);
  }
  for (const p of Object.values(s.pools)) {
    if ((p.funding === "opening" || p.funding === "closing" || p.funding === "recovery") && p.recoveryAt > s.now) times.push(p.recoveryAt);
    if (p.requestId) {
      const r = s.requests[p.requestId];
      if (r.state === "pending") times.push(r.lastProgressAt + s.config.requestTimeoutMs);
    }
  }
  const future = times.filter(t => t > s.now);
  return future.length ? Math.min(...future) : null;
}

export function step(previous: State, event: Event): Result {
  identity(event.eventId);
  if (event.taskId !== previous.taskId || !event.eventId) throw new Error("Wrong task event");
  integer(event.receivedAt); integer(event.occurredAt);
  if (event.occurredAt > event.receivedAt) throw new Error("Event received before occurrence");
  if (previous.seenEvents[event.eventId]) return { state: previous, commands: [], view: view(previous), nextWakeAt: nextWakeAt(previous) };
  if (event.receivedAt < previous.now) throw new Error("Receive clock moved backwards");
  const s = clone(previous);
  s.now = event.receivedAt; s.revision++; s.seenEvents[event.eventId] = true;
  reduce(s, event);
  for (const p of Object.values(s.pools)) if (["opening", "closing"].includes(p.funding) && p.recoveryAt <= s.now) p.funding = "recovery";
  const commands = plan(s);
  return { state: s, commands, view: view(s), nextWakeAt: nextWakeAt(s) };
}
