import { availableContent, hasArchive, pendingContent, recommendations, seatCap, sellerSpeed, unmeasuredCap, view } from "./recommend.js";
import { identity, integer, price, reserve, sats, validateFees, validateQuote } from "./math.js";
import { addContent, assertRequestPrices, recordFailedAttempt, reduce } from "./reducer.js";
import type { Command, Config, Content, Event, Pool, Quote, Result, State } from "./types.js";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateConfig(c: Config) {
  sats(c.maxBlockPrice);
  for (const value of [c.baseSeats, c.floatingSeats, c.poolBlocks, c.requestTimeoutMs]) integer(value, 1);
}
export function createTask(input: {
  taskId: string; seedHash: string; config: Config; content: Content[];
  manifestKnown: boolean; reused?: string[];
}): State {
  identity(input.taskId); identity(input.seedHash);
  validateConfig(input.config);
  const state: State = {
    version: 1, taskId: input.taskId, seedHash: input.seedHash, revision: 0, sequence: 0, now: 0,
    config: clone(input.config), intent: "ready",
    price: { mode: "auto", manualValue: null }, seats: [],
    manifestKnown: input.manifestKnown, content: {}, completed: {}, sellers: {}, pools: {}, requests: {},
    wallet: { revision: -1, available: "0", reflectedCommands: [] }, spent: "0", seenEvents: {},
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
  if (!["ready", "run", "pause", "cancel"].includes(s.intent)) throw new Error("Invalid snapshot intent");
  sats(s.spent); sats(s.wallet.available);
  if (!s.price || !["auto", "manual"].includes(s.price.mode)) throw new Error("Invalid snapshot slider");
  if (s.price.manualValue !== null) sats(s.price.manualValue);
  if (s.price.mode === "manual" && s.price.manualValue === null) throw new Error("Missing manual target");
  if (!Array.isArray(s.seats)) throw new Error("Invalid snapshot seats");
  for (const id of s.seats) { identity(id); if (!s.sellers[id]) throw new Error("Unknown seat seller"); }
  for (const [key, c] of Object.entries(s.content)) if (key !== c.id) throw new Error("Content key mismatch");
  addContent(s, Object.values(s.content));
  for (const id of Object.keys(s.completed)) if (!s.content[id]) throw new Error("Unknown completed content");
  for (const [id, seller] of Object.entries(s.sellers)) {
    identity(id);
    if (id !== seller.id) throw new Error("Seller key mismatch");
    if (seller.quote) { validateQuote(seller.quote); if (seller.quote.sellerId !== id) throw new Error("Quote seller mismatch"); }
    seller.blacklisted ??= false;
    if (typeof seller.blacklisted !== "boolean") throw new Error("Invalid blacklist flag");
    if (seller.failureCount !== undefined) integer(seller.failureCount, 0);
    seller.failureCount ??= 0;
    seller.bytesTotal ??= 0; seller.timeMsTotal ??= 0;
    integer(seller.bytesTotal, 0); integer(seller.timeMsTotal, 0);
    seller.measured ??= false;
    if (typeof seller.measured !== "boolean") throw new Error("Invalid measured flag");
    if (seller.measured && seller.timeMsTotal <= 0) throw new Error("Measured seller without recorded time");
    if (seller.lastAt === undefined) seller.lastAt = null;
    if (seller.lastAt !== null) integer(seller.lastAt, 0);
  }
  for (const p of Object.values(s.pools)) {
    if (p.taskId !== s.taskId) throw new Error("Cross-task pool snapshot");
    validateQuote(p.quote); validateFees(p.fees);
    if (!s.sellers[p.sellerId] || p.quote.sellerId !== p.sellerId) throw new Error("Missing pool seller");
    if (!["opening", "open", "closing", "closed", "failed", "problem"].includes(p.funding)) throw new Error("Invalid funding state");
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
/** 任务调度内的存活池：已关闭、已失败和问题池都不再参与。 */
function live(p: Pool) { return !["closed", "failed", "problem"].includes(p.funding); }
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
/** 确定性伪随机：同一状态与候选集合在重放中必然选中同一卖家。 */function pickRandom(s: State, ids: string[]): string {
  const sorted = [...ids].sort();
  let h = 2166136261;
  const seed = `${s.taskId}|${s.sequence}|${sorted.join(",")}`;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return sorted[h % sorted.length];
}

/** 该卖家是否有未决在途请求：在途者只参与算名次，不被踢。 */
function hasInFlight(s: State, sellerId: string): boolean {
  return Object.values(s.pools).some(p => {
    const r = p.requestId ? s.requests[p.requestId] : undefined;
    return p.sellerId === sellerId && !!r && (r.state === "pending" || r.state === "unresolved");
  });
}

/** 席位优劣（前面的优先保留）：有在途责任者 → 有测速档案者 → 速度更快者 → 稳定 ID。 */
function bestSeatFirst(s: State) {
  return (a: string, b: string) =>
    Number(hasInFlight(s, b)) - Number(hasInFlight(s, a))
    || Number(hasArchive(s, b)) - Number(hasArchive(s, a))
    || (sellerSpeed(s, b) ?? 0) - (sellerSpeed(s, a) ?? 0)
    || a.localeCompare(b);
}

/**
 * 席位评审：只在费用池"下载完成并进入 drain"的那一刻发生。
 * 只评审**本轮刚进入 drain** 的卖家（显式传入），不拿历史 draining 池重复评审。
 * 排名集合 = 在席且已测速的卖家（在途者只参与算名次）。
 * 名次 ≤ 基础名额 → 保留；名次 > 基础名额 → 一换一：
 *   a. 闲置已测速卖家里最快且比它快 → 替换；
 *   b. 否则有未测速闲置且浮动位未满 → 随机挑一名替换；
 *   c. 否则不换，续约。
 */
function reviewSeats(s: State, drained: Set<string>, desired: Set<string>, qualified: Quote[]) {
  for (const drainSeller of drained) {
    if (!desired.has(drainSeller) || !hasArchive(s, drainSeller)) continue;
    // 在途责任优先：有未决请求的卖家不被替换。
    if (hasInFlight(s, drainSeller)) continue;
    const ranked = [...desired].filter(id => hasArchive(s, id))
      .sort((a, b) => (sellerSpeed(s, b)! - sellerSpeed(s, a)!) || a.localeCompare(b));
    const rank = ranked.indexOf(drainSeller) + 1;
    if (rank <= s.config.baseSeats) continue;
    const idle = qualified.filter(q => !desired.has(q.sellerId));
    const measuredIdle = idle.filter(q => hasArchive(s, q.sellerId))
      .sort((a, b) => (sellerSpeed(s, b.sellerId)! - sellerSpeed(s, a.sellerId)!) || a.sellerId.localeCompare(b.sellerId));
    if (measuredIdle.length && sellerSpeed(s, measuredIdle[0].sellerId)! > sellerSpeed(s, drainSeller)!) {
      desired.delete(drainSeller); desired.add(measuredIdle[0].sellerId); continue;
    }
    const unmeasuredInSeat = [...desired].filter(id => !hasArchive(s, id)).length;
    const unmeasuredIdle = idle.filter(q => !hasArchive(s, q.sellerId)).map(q => q.sellerId);
    if (unmeasuredIdle.length && unmeasuredInSeat < s.config.floatingSeats) {
      desired.delete(drainSeller); desired.add(pickRandom(s, unmeasuredIdle)); continue;
    }
  }
}

function plan(s: State): Command[] {
  const commands: Command[] = [];
  for (const r of Object.values(s.requests)) {
    if (r.state !== "pending" || s.now < r.lastProgressAt + s.config.requestTimeoutMs) continue;
    // 停摆是网络错误：请求结束、卖家按零字节记一次尝试（已测、不拉黑），池走正常关池回收。
    const p = s.pools[r.poolId];
    r.state = "rejected"; p.requestId = null;
    recordFailedAttempt(s.sellers[p.sellerId], r.transferredBytes, r.startedAt, s.now);
    drain(s, p, commands, "request-timeout");
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

  // 席位收缩：限额变小、或出现未测速在席卖家超限时，让超额席位退出。
  // 退出只做 drain：停止分配新块，已确认付款与在途责任照常完成。
  const trimmed = new Set<string>();
  {
    const order = [...desired].sort(bestSeatFirst(s));
    const keep = new Set<string>();
    let unmeasured = 0;
    for (const id of order) {
      const archived = hasArchive(s, id);
      if (keep.size >= seatCap(s) || (!archived && unmeasured >= unmeasuredCap(s))) { trimmed.add(id); continue; }
      keep.add(id); if (!archived) unmeasured++;
    }
    for (const id of trimmed) desired.delete(id);
  }

  const claimed = new Set(Object.values(s.requests).filter(r => ["pending", "unresolved"].includes(r.state)).flatMap(r => r.contentIds));
  const drainedSellers = new Set<string>();
  for (const p of livePools) {
    if (p.funding !== "open" || p.requestId) continue;
    if (p.scheduling === "draining") continue;
    if (!enabled || awaitingManifest) continue;
    if (!desired.has(p.sellerId)) continue;
    // 锁价合同可以在原报价过期后继续使用；新请求仍受当前有效价格上限约束。
    if (sats(p.quote.blockPrice) > rec.effective) continue;
    let items = availableContent(s, p.quote).filter(c => !claimed.has(c.id));
    if (items.length) {
      const seedFirst = items[0].kind === "seed";
      const remaining = Math.max(0, p.blockCapacity - p.purchasedBlocks);
      // 一个池 = 一批 = 一次请求：首次也是正式下载，一次派满剩余容量（Seed 单条目先买）。
      items = items.slice(0, seedFirst ? 1 : remaining);
    }
    while (items.length && items.reduce((n, c) => n + price(p.quote, c), 0n)
      + reserve(p.fees, items.length) > sats(p.amount) - sats(p.committed)) items.pop();
    if (!items.length) {
      if (availableContent(s, p.quote).some(c => !claimed.has(c.id))) {
        drain(s, p, commands, "pool-capacity");
        drainedSellers.add(p.sellerId);
      }
      continue;
    }
    const requestId = nextId(s, "request");
    const prices = Object.fromEntries(items.map(c => [c.id, String(price(p.quote, c))]));
    const command: Command = { ...base(s, items[0].kind === "seed" ? "seed-first" : "download"),
      type: "download", poolId: p.id, requestId, contentIds: items.map(c => c.id), prices,
      maxPayment: String(Object.values(prices).reduce((n, v) => n + sats(v), 0n)),
      priceLimit: String(rec.effective), feeVersion: p.fees.version };
    s.requests[requestId] = { id: requestId, commandId: command.commandId, poolId: p.id,
      contentIds: command.contentIds, prices, startedAt: s.now, lastProgressAt: s.now,
      transferredBytes: 0, state: "pending" };
    p.requestId = requestId; p.scheduling = "serving";
    for (const c of items) claimed.add(c.id);
    commands.push(command);
  }

  // 只有发生"池下载完成并进入 drain"时，才做一次席位评审；不在每个事件全量重排。
  if (drainedSellers.size && enabled) reviewSeats(s, drainedSellers, desired, qualified);

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
      p.funding = "closing"; p.closeCommandId = command.commandId; commands.push(command);
    }
  }

  if (enabled && !awaitingManifest) {
    // 补席位：有档案者按速度降序优先；未测速者随机补浮动位。
    const cap = seatCap(s);
    if (desired.size < cap) {
      const measuredIdle = qualified.filter(q => !desired.has(q.sellerId) && !trimmed.has(q.sellerId) && hasArchive(s, q.sellerId))
        .sort((a, b) => (sellerSpeed(s, b.sellerId)! - sellerSpeed(s, a.sellerId)!) || a.sellerId.localeCompare(b.sellerId));
      for (const q of measuredIdle) { if (desired.size >= cap) break; desired.add(q.sellerId); }
      let unmeasured = [...desired].filter(id => !hasArchive(s, id)).length;
      const unmeasuredIdle = qualified.filter(q => !desired.has(q.sellerId) && !trimmed.has(q.sellerId) && !hasArchive(s, q.sellerId)).map(q => q.sellerId);
      while (desired.size < cap && unmeasured < unmeasuredCap(s) && unmeasuredIdle.length) {
        const chosen = pickRandom(s, unmeasuredIdle);
        unmeasuredIdle.splice(unmeasuredIdle.indexOf(chosen), 1);
        desired.add(chosen); unmeasured++;
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
      // 没有 Seed 可买、块数又降到 0：这个池买不到任何内容，只会在关闭时白白花掉开池费。等资金。
      if (count === 0 && seeds.length === 0) continue;
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
        refundAvailable: false, openingObserved: false,
        walletRevisionAtIntent: s.wallet.revision,
      };
      commands.push(command);
    }
  }
  s.seats = [...desired];
  return commands;
}

export function nextWakeAt(s: State): number | null {
  const times: number[] = [];
  for (const seller of Object.values(s.sellers)) {
    if (seller.quote && seller.quote.expiresAt > s.now) times.push(seller.quote.expiresAt);
  }
  for (const p of Object.values(s.pools)) {
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
  const commands = plan(s);
  return { state: s, commands, view: view(s), nextWakeAt: nextWakeAt(s) };
}
