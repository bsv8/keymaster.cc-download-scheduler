import { byPrice, availableContent, pendingContent, recommendations, sellerSpeed, seatCap, unmeasuredCap, view } from "./recommend.js";
import { identity, integer, price, reserve, sats, validateFees, validateQuote } from "./math.js";
import { addContent, assertRequestPrices, reduce } from "./reducer.js";
import type { Command, Config, Content, Event, Pool, Quote, Result, State } from "./types.js";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateConfig(c: Config) {
  sats(c.maxBlockPrice);
  for (const value of [c.priceSeats, c.speedSeats, c.speedFloatingSeats, c.poolBlocks, c.sampleWindowMs,
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
    price: { mode: "auto", manualValue: null }, seats: [],
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
  if (!s.price || !["auto", "manual"].includes(s.price.mode)) throw new Error("Invalid snapshot slider");
  if (s.price.manualValue !== null) sats(s.price.manualValue);
  if (s.price.mode === "manual" && s.price.manualValue === null) throw new Error("Missing manual target");
  for (const id of s.seats) { identity(id); if (!s.sellers[id]) throw new Error("Unknown seat seller"); }
  for (const [key, c] of Object.entries(s.content)) if (key !== c.id) throw new Error("Content key mismatch");
  addContent(s, Object.values(s.content));
  for (const id of Object.keys(s.completed)) if (!s.content[id]) throw new Error("Unknown completed content");
  for (const [id, seller] of Object.entries(s.sellers)) {
    identity(id);
    if (id !== seller.id) throw new Error("Seller key mismatch");
    if (seller.quote) { validateQuote(seller.quote); if (seller.quote.sellerId !== id) throw new Error("Quote seller mismatch"); }
    if (seller.evictedVersion !== undefined) integer(seller.evictedVersion, 0);
    seller.evictedVersion ??= 0;
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
function active(p: Pool) { return p.scheduling !== "draining" && p.scheduling !== "retired"; }
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
function hasInFlight(s: State, sellerId: string) {
  return Object.values(s.pools).some(p => p.sellerId === sellerId && live(p) && p.requestId !== null);
}

/** 准入排序：price 用价格升序；speed 先按实测速度降序，未测速的按价格升序补浮动位。 */
function admissionOrder(s: State, a: Quote, b: Quote): number {
  if (s.preference === "price") return byPrice(a, b);
  const sa = sellerSpeed(s, a.sellerId), sb = sellerSpeed(s, b.sellerId);
  if (sa !== null && sb !== null) return (sb - sa) || byPrice(a, b);
  if (sa !== null) return -1;
  if (sb !== null) return 1;
  return byPrice(a, b);
}

/**
 * 席位评审：只在费用池"下载完成并进入 drain"的那一刻发生。
 * price：席位满时，用最便宜的闲置卖家与刚 drain 的卖家一比一比较，便宜才换。
 * speed：踢位数 = 在席数 − 正式席位（上限浮动位）；只踢本轮可淘汰的末位，未测速/在途受保护。
 */
function reviewSeats(s: State, desired: Set<string>, qualified: Quote[], commands: Command[]) {
  const waiting = qualified.filter(q => !desired.has(q.sellerId));
  if (!waiting.length) return;
  if (s.preference === "price") {
    if (desired.size < s.config.priceSeats) return;
    const cheapest = [...waiting].sort(byPrice)[0];
    for (const id of [...desired]) {
      const draining = Object.values(s.pools).find(p => p.sellerId === id && live(p) && p.scheduling === "draining");
      if (draining && sats(draining.quote.blockPrice) > sats(cheapest.blockPrice)) {
        desired.delete(id); s.sellers[id].evictedVersion = s.sellers[id].quote?.version ?? 0; return;
      }
    }
    return;
  }
  const quota = Math.min(Math.max(desired.size - s.config.speedSeats, 0), s.config.speedFloatingSeats);
  if (quota <= 0) return;
  const evictable = [...desired].filter(id => !hasInFlight(s, id) && sellerSpeed(s, id) !== null);
  evictable.sort((a, b) => (sellerSpeed(s, a)! - sellerSpeed(s, b)!) || a.localeCompare(b));
  const count = Math.min(quota, evictable.length, waiting.length);
  for (const id of evictable.slice(0, count)) {
    desired.delete(id);
    s.sellers[id].evictedVersion = s.sellers[id].quote?.version ?? 0;
    for (const p of Object.values(s.pools)) if (p.sellerId === id && live(p)) drain(s, p, commands, "seat-review");
  }
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
  const livePools = Object.values(s.pools).filter(live);
  const qualified = enabled ? rec.quotes : [];
  const qualifiedIds = new Set(qualified.map(q => q.sellerId));

  // 基础席位：持久化席位中仍在候选集合里的卖家。未合格的席位自动退出。
  const desired = new Set<string>();
  for (const id of s.seats) if (qualifiedIds.has(id)) desired.add(id);

  const claimed = new Set(Object.values(s.requests).filter(r => ["pending", "unresolved"].includes(r.state)).flatMap(r => r.contentIds));
  let capacityDrain = false;
  for (const p of livePools) {
    if (p.funding !== "open" || p.requestId) continue;
    if (p.scheduling === "draining") continue;
    if (!enabled || awaitingManifest) continue;
    if (!desired.has(p.sellerId)) continue;
    // 锁价合同可以在原报价过期后继续使用；新请求仍受当前有效价格上限约束。
    if (sats(p.quote.blockPrice) > rec.effective) continue;
    let items = availableContent(s, p.quote).filter(c => !claimed.has(c.id));
    const unmeasured = sellerSpeed(s, p.sellerId) === null;
    if (items.length) {
      const seedFirst = items[0].kind === "seed";
      const limit = seedFirst || unmeasured ? 1 : Math.max(0, p.blockCapacity - p.purchasedBlocks);
      items = items.slice(0, limit);
    }
    while (items.length && items.reduce((n, c) => n + price(p.quote, c), 0n)
      + reserve(p.fees, items.length) > sats(p.amount) - sats(p.committed)) items.pop();
    if (!items.length) {
      if (availableContent(s, p.quote).some(c => !claimed.has(c.id))) {
        drain(s, p, commands, "pool-capacity");
        capacityDrain = true;
      }
      continue;
    }
    const requestId = nextId(s, "request");
    const prices = Object.fromEntries(items.map(c => [c.id, String(price(p.quote, c))]));
    const command: Command = { ...base(s, unmeasured || items[0].kind === "seed" ? "probe-real-content" : "continue"),
      type: "download", poolId: p.id, requestId, contentIds: items.map(c => c.id), prices,
      maxPayment: String(Object.values(prices).reduce((n, v) => n + sats(v), 0n)),
      priceLimit: String(rec.effective), feeVersion: p.fees.version };
    s.requests[requestId] = { id: requestId, commandId: command.commandId, poolId: p.id,
      contentIds: command.contentIds, prices, startedAt: s.now, lastProgressAt: s.now,
      transferredBytes: 0, state: "pending" };
    p.requestId = requestId; p.scheduling = command.reason === "probe-real-content" ? "probing" : "serving";
    for (const c of items) claimed.add(c.id);
    commands.push(command);
  }

  // 只有发生"池下载完成并进入 drain"时，才做一次席位评审；不在每个事件全量重排。
  if (capacityDrain && enabled) reviewSeats(s, desired, qualified, commands);

  for (const p of livePools) {
    if (!enabled) { drain(s, p, commands, complete ? "content-complete" : s.intent); continue; }
    if (awaitingManifest) continue;
    if (!desired.has(p.sellerId)) {
      drain(s, p, commands, sats(p.quote.blockPrice) > rec.effective ? "price-limit" : "strategy-change");
    }
  }

  for (const p of Object.values(s.pools)) {
    if (p.funding !== "open" || p.requestId) continue;
    if (p.scheduling === "draining") {
      const command: Command = { ...base(s, p.drainReason ?? "drain-complete"), type: "close", poolId: p.id, committed: p.committed };
      p.funding = "closing"; p.closeCommandId = command.commandId;
      p.recoveryAt = s.now + s.config.requestTimeoutMs; commands.push(command);
    }
  }

  if (enabled && !awaitingManifest) {
    // 补席位：未满时合格卖家直接入场；speed 策略下未测速卖家受浮动位限位。
    const cap = seatCap(s);
    let unmeasured = [...desired].filter(id => sellerSpeed(s, id) === null).length;
    if (desired.size < cap) {
      const waiting = qualified.filter(q => !desired.has(q.sellerId)).sort((a, b) => admissionOrder(s, a, b));
      const umCap = unmeasuredCap(s);
      for (const q of waiting) {
        if (desired.size >= cap) break;
        const seller = s.sellers[q.sellerId];
        // 本轮刚刚被淘汰的卖家不能在同一计划里重新入场。
        if ((seller.evictedVersion ?? 0) >= q.version) continue;
        const measured = sellerSpeed(s, q.sellerId) !== null;
        if (!measured && unmeasured >= umCap) continue;
        desired.add(q.sellerId);
        if (!measured) unmeasured++;
      }
    }
    for (const id of desired) {
      if (livePools.some(p => p.sellerId === id && active(p))) continue;
      const q = qualified.find(x => x.sellerId === id);
      if (!q) continue;
      const seller = s.sellers[id];
      const newQuote = seller.quote;
      if (!newQuote || newQuote.expiresAt <= s.now || newQuote.id !== q.id || newQuote.version !== q.version) continue;
      const items = pendingContent(s).filter(c => !claimed.has(c.id) && (!q.contentIds || q.contentIds.includes(c.id)));
      if (!items.length) continue;
      const blocks = items.filter(c => c.kind === "block");
      const seeds = items.filter(c => c.kind === "seed");
      let count = Math.min(blocks.length, q.maxBlocks, s.config.poolBlocks);
      let budget = 0n, amount = 0n;
      while (count >= 0) {
        budget = [...seeds, ...blocks.slice(0, count)].reduce((n, c) => n + price(q, c), 0n);
        amount = budget + reserve(q.fees, Math.max(1, count));
        if (amount + sats(q.fees.opening) <= walletFree(s)) break;
        count--;
      }
      if (count < 0) continue;
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
  }
  s.seats = [...desired];
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
