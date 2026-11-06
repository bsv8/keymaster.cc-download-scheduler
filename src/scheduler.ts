import { debugEnabled, debugLog } from "./debug.js";
import { availableContent, hasArchive, pendingContent, recommendations, seatCap, sellerSpeed, unmeasuredCap, validQuotes, view } from "./recommend.js";
import { identity, integer, price, reserve, sats, validateFees, validateQuote } from "./math.js";
import { applyFileInfo, assertRequestPrices, recordFailedAttempt, reduce, registerSeed } from "./reducer.js";
import { deriveFileInfo, parseFileInfo, type DerivedFileInfo } from "./manifest.js";
import type { Command, Config, Content, CreateTaskInput, Event, Pool, Quote, Result, State } from "./types.js";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateConfig(c: Config) {
  sats(c.maxBlockPrice);
  for (const value of [c.baseSeats, c.floatingSeats, c.poolBlocks, c.requestTimeoutMs]) integer(value, 1);
}
/** 校验恢复快照的 manifest 字段；非法一律拒绝。 */
function validateRestoredManifest(s: State): DerivedFileInfo | null {
  if (!("manifest" in s)) throw new Error("Unsupported task snapshot");
  if (s.manifest === null) return null;
  if (typeof s.manifest !== "object" || Array.isArray(s.manifest)) throw new Error("Unsupported task snapshot");
  const extra = Object.keys(s.manifest).filter(key => !["fileBytes", "blockBytes", "blockHashes"].includes(key));
  if (extra.length) throw new Error("Unsupported task snapshot");
  try {
    return deriveFileInfo(s.seedHash, s.manifest.fileBytes, s.manifest.blockBytes, s.manifest.blockHashes);
  } catch {
    throw new Error("Unsupported task snapshot");
  }
}

/** 恢复校验：恰好一个 Seed 且 id 等于 seedHash；块集合与清单推导完全一致。 */
function validateRestoredContent(s: State, derived: DerivedFileInfo | null) {
  const entries = Object.values(s.content);
  const seeds = entries.filter(item => item.kind === "seed");
  if (seeds.length !== 1 || seeds[0]!.id !== s.seedHash) throw new Error("Unsupported task snapshot");
  if (seeds[0]!.bytes !== undefined) throw new Error("Unsupported task snapshot");
  const blocks = new Map<string, number>();
  for (const item of entries) {
    if (item.kind === "seed") continue;
    if (item.kind !== "block") throw new Error("Unsupported task snapshot");
    if (item.bytes === undefined || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new Error("Unsupported task snapshot");
    blocks.set(item.id, item.bytes);
  }
  if (!derived) {
    if (blocks.size !== 0) throw new Error("Unsupported task snapshot");
    return;
  }
  if (blocks.size !== derived.blocks.size) throw new Error("Content key mismatch");
  for (const [id, bytes] of derived.blocks) {
    const actual = blocks.get(id);
    if (actual === undefined) throw new Error("Content key mismatch");
    if (actual !== bytes) throw new Error("Conflicting content identity");
  }
}

export interface DownloadScheduler {
  /** 冻结的构造配置副本；任务创建时再深拷贝进快照。 */
  readonly config: Readonly<Config>;
  createTask(input: CreateTaskInput): State;
}

/**
 * 创建下载调度器实例；构造即校验配置。一个实例一份配置，同一实例可创建多个任务；
 * 席位仍按任务分别计算。不引入网络、定时器、持久化或自动执行。
 */
export function createDownloadScheduler(config: Config): DownloadScheduler {
  validateConfig(config);
  const defaults = Object.freeze(clone(config));
  return {
    config: defaults,
    createTask(input: CreateTaskInput): State {
      if (input === null || typeof input !== "object") throw new Error("Invalid task input");
      identity(input.taskId);
      identity(input.seedHash);
      const parsed = parseFileInfo(input.seedHash, input);
      const state: State = {
        version: 1, taskId: input.taskId, seedHash: input.seedHash, revision: 0, sequence: 0, now: 0,
        config: clone(defaults), intent: "ready", failure: null, price: { mode: "auto", manualValue: null }, seats: [],
        manifest: null, content: {}, completed: {}, sellers: {}, pools: {}, requests: {},
        spent: "0", seenEvents: {},
      };
      registerSeed(state);
      if (parsed) {
        applyFileInfo(state, parsed.derived, parsed.reused);
        // 提供完整文件信息即声明本地 Seed 已验证：内核跳过购买。
        state.completed[state.seedHash] = "reused";
      }
      return state;
    },
  };
}

/** 显式恢复快照；重放输入不会重新发出已经持久化的执行意图。 */
export function restoreTask(snapshot: State): State {
  const s = clone(snapshot);
  // 单一格式：旧格式/附带废弃字段一律拒绝，不做静默剥离或迁移。
  if (
    "wallet" in (s as State & { wallet?: unknown })
    || Object.values(s.pools ?? {}).some(pool => "walletRevisionAtIntent" in (pool as Pool & { walletRevisionAtIntent?: unknown }))
    || (s.failure && "available" in s.failure)
    || "manifestKnown" in (s as State & { manifestKnown?: unknown })
  ) throw new Error("Unsupported task snapshot");
  if (s.version !== 1 || !s.taskId || !s.seedHash) throw new Error("Unsupported task snapshot");
  validateConfig(s.config); integer(s.now); integer(s.revision); integer(s.sequence);
  s.failure ??= null;
  if (s.quoteDiscovery) {
    for (const key of ["enabled", "armed", "requested", "failed"] as const) {
      if (typeof s.quoteDiscovery[key] !== "boolean") throw new Error("Invalid quote discovery state");
    }
    if (s.quoteDiscovery.pendingCommandId !== null) identity(s.quoteDiscovery.pendingCommandId);
  }
  identity(s.taskId); identity(s.seedHash);
  const derivedManifest = validateRestoredManifest(s);
  if (!["ready", "run", "pause", "cancel"].includes(s.intent)) throw new Error("Invalid snapshot intent");
  sats(s.spent);
  if (s.failure !== null) {
    if (s.failure.code !== "insufficient-funds" || !s.sellers[s.failure.sellerId]) throw new Error("Invalid task failure");
    sats(s.failure.required);
  }
  if (!s.price || !["auto", "manual"].includes(s.price.mode)) throw new Error("Invalid snapshot slider");
  if (s.price.manualValue !== null) sats(s.price.manualValue);
  if (s.price.mode === "manual" && s.price.manualValue === null) throw new Error("Missing manual target");
  if (!Array.isArray(s.seats)) throw new Error("Invalid snapshot seats");
  for (const id of s.seats) { identity(id); if (!s.sellers[id]) throw new Error("Unknown seat seller"); }
  for (const [key, c] of Object.entries(s.content)) if (key !== c.id) throw new Error("Content key mismatch");
  validateRestoredContent(s, derivedManifest);
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
    if (p.quote) validateQuote(p.quote);
    p.openingFee ??= p.quote?.fees.opening ?? "0";
    sats(p.openingFee); validateFees(p.fees);
    if (!s.sellers[p.sellerId] || (p.quote && p.quote.sellerId !== p.sellerId)) throw new Error("Missing pool seller");
    if (!["opening", "open", "closing", "closed", "failed", "problem"].includes(p.funding)) throw new Error("Invalid funding state");
    integer(p.blockCapacity); integer(p.purchasedBlocks);
    // 累计购买量不限制池寿命；每次派发按金额和实际费用重新判断。
    sats(p.amount); sats(p.committed);
    if (sats(p.committed) > sats(p.amount)) throw new Error("Corrupt pool commitment");
    if (p.requestId && !s.requests[p.requestId]) throw new Error("Missing unresolved request");
  }
  const claims = new Set<string>();
  for (const r of Object.values(s.requests)) {
    if (!s.pools[r.poolId] || r.contentIds.some(id => !s.content[id])) throw new Error("Orphan request");
    if (new Set(r.contentIds).size !== r.contentIds.length) throw new Error("Duplicate request content");
    if (!r.quote) {
      const original = s.pools[r.poolId].quote;
      if (!original) throw new Error("Missing purchase quote evidence");
      r.quote = clone(original);
    }
    validateQuote(r.quote);
    if (["planned", "pending", "unresolved"].includes(r.state)) {
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
 * 席位评审：仅在一次购买已明确结束后评审该卖家。
 * 与资金池是否耗尽、是否关闭无关，不对其他在途卖家重新洗牌。
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

function contentCost(q: Quote, items: Content[]): bigint {
  return items.reduce((n, item) => n + price(q, item), 0n);
}

/** 一份工作从准备资金起排他占用内容；池可用后发出同一份工作。 */
function dispatch(s: State, p: Pool, r: State["requests"][string], commands: Command[]) {
  r.state = "pending"; r.startedAt = s.now; r.lastProgressAt = s.now;
  const command: Command = { ...base(s, s.content[r.contentIds[0]].kind === "seed" ? "seed-first" : "download"),
    type: "download", poolId: p.id, requestId: r.id, quote: clone(r.quote), contentIds: [...r.contentIds], prices: { ...r.prices },
    maxPayment: String(Object.values(r.prices).reduce((n, v) => n + sats(v), 0n)),
    priceLimit: String(recommendations(s).effective), feeVersion: p.fees.version };
  r.commandId = command.commandId; p.requestId = r.id; p.scheduling = "serving";
  commands.push(command);
}

function plan(s: State, reviewedSeller?: string): Command[] {
  const commands: Command[] = [];
  for (const r of Object.values(s.requests)) {
    if (r.state !== "pending" || s.now < r.lastProgressAt + s.config.requestTimeoutMs) continue;
    const p = s.pools[r.poolId];
    // 超时不能证明已发授权的责任消失。留作未决，不能重买原内容。
    r.state = "unresolved";
    recordFailedAttempt(s.sellers[p.sellerId], r.transferredBytes, r.startedAt, s.now);
    drain(s, p, commands, "request-timeout");
    p.funding = "problem"; p.scheduling = "retired";
  }
  const rec = recommendations(s);
  if (s.quoteDiscovery && validQuotes(s).length) {
    s.quoteDiscovery.armed = true; s.quoteDiscovery.failed = false;
  }
  const complete = s.manifest !== null && pendingContent(s).length === 0;
  const enabled = s.intent === "run" && !s.failure && !complete;
  const awaitingManifest = s.manifest === null && pendingContent(s).length === 0;
  const qualified = enabled ? rec.quotes : [];
  const ids = new Set(qualified.map(q => q.sellerId));
  const desired = new Set(s.seats.filter(id => awaitingManifest || ids.has(id)));
  const trimmed = new Set<string>();
  let unmeasured = 0, kept = 0;
  for (const id of [...desired].sort(bestSeatFirst(s))) {
    const measured = hasArchive(s, id);
    if (kept >= seatCap(s) || (!measured && unmeasured >= unmeasuredCap(s))) {
      desired.delete(id); trimmed.add(id);
    } else { kept++; if (!measured) unmeasured++; }
  }
  if (enabled && reviewedSeller) reviewSeats(s, new Set([reviewedSeller]), desired, qualified);
  if (enabled && !awaitingManifest) {
    const measured = qualified.filter(q => !desired.has(q.sellerId) && !trimmed.has(q.sellerId) && hasArchive(s, q.sellerId))
      .sort((a, b) => (sellerSpeed(s, b.sellerId)! - sellerSpeed(s, a.sellerId)!) || a.sellerId.localeCompare(b.sellerId));
    for (const q of measured) { if (desired.size >= seatCap(s)) break; desired.add(q.sellerId); }
    const newcomers = qualified.filter(q => !desired.has(q.sellerId) && !trimmed.has(q.sellerId) && !hasArchive(s, q.sellerId)).map(q => q.sellerId);
    unmeasured = [...desired].filter(id => !hasArchive(s, id)).length;
    while (desired.size < seatCap(s) && unmeasured < unmeasuredCap(s) && newcomers.length) {
      const id = pickRandom(s, newcomers); newcomers.splice(newcomers.indexOf(id), 1);
      desired.add(id); unmeasured++;
    }
  }
  s.seats = [...desired];

  // 取消尚未形成购买授权的工作；pending/unresolved 责任不能因此解除。
  for (const p of Object.values(s.pools).filter(live)) {
    const exit = !enabled ? (s.failure?.code ?? (complete ? "content-complete" : s.intent))
      : !awaitingManifest && !desired.has(p.sellerId) ? "strategy-change" : undefined;
    if (!exit || (s.intent === "ready" && !s.failure && !complete)) continue;
    const r = p.requestId ? s.requests[p.requestId] : undefined;
    if (r?.state === "planned" && (!s.failure || s.intent !== "run" || complete)) { r.state = "rejected"; p.requestId = null; }
    drain(s, p, commands, exit);
  }

  // 已分配且已持久化的工作继续；终态错误仅阻止新分配，不能随回调顺序撤销它。
  if (s.intent === "run" && !complete) for (const p of Object.values(s.pools)) {
    const r = p.requestId ? s.requests[p.requestId] : undefined;
    if (p.funding !== "open" || r?.state !== "planned") continue;
    const items = r.contentIds.map(id => s.content[id]);
    if (sats(r.quote.blockPrice) > rec.effective || r.quote.expiresAt <= s.now
      || contentCost(r.quote, items) + reserve(p.fees, items.length) > sats(p.amount) - sats(p.committed)) {
      r.state = "rejected"; p.requestId = null;
      drain(s, p, commands, "work-invalidated");
    } else dispatch(s, p, r, commands);
  }

  const claimed = new Set(Object.values(s.requests)
    .filter(r => ["planned", "pending", "unresolved"].includes(r.state)).flatMap(r => r.contentIds));
  const measuredOrder = [...desired].filter(id => hasArchive(s, id))
    .sort((a, b) => (sellerSpeed(s, b)! - sellerSpeed(s, a)!) || a.localeCompare(b));
  const randomOrder: string[] = [];
  const remaining = [...desired].filter(id => !hasArchive(s, id));
  while (remaining.length) { const id = pickRandom(s, remaining); remaining.splice(remaining.indexOf(id), 1); randomOrder.push(id); }

  if (enabled && !awaitingManifest) for (const id of [...measuredOrder, ...randomOrder]) {
    if (s.failure) break;
    let p = Object.values(s.pools).find(p => p.sellerId === id && live(p) && active(p));
    const old = p?.requestId ? s.requests[p.requestId] : undefined;
    if (old) continue;
    if (p && p.funding !== "open") continue;
    const q = qualified.find(q => q.sellerId === id);
    if (!q) continue;
    let items = availableContent(s, q).filter(item => !claimed.has(item.id));
    items = items.slice(0, items[0]?.kind === "seed" ? 1 : Math.min(q.maxBlocks, s.config.poolBlocks));
    if (!items.length) continue;
    if (p) {
      const affordable = [...items];
      while (affordable.length && contentCost(q, affordable) + reserve(p.fees, affordable.length) > sats(p.amount) - sats(p.committed)) affordable.pop();
      if (affordable.length) items = affordable;
      else { drain(s, p, commands, "pool-exhausted"); p = undefined; }
    }
    // New funding is demand-driven. Only the wallet manager can reject it
    // for insufficient funds; never shrink work to consume the remaining balance.
    const requestId = nextId(s, "request");
    const poolId = p?.id ?? nextId(s, "pool");
    const prices = Object.fromEntries(items.map(item => [item.id, String(price(q, item))]));
    const work: State["requests"][string] = { id: requestId, commandId: "", poolId,
      quote: clone(q), contentIds: items.map(item => item.id), prices,
      startedAt: s.now, lastProgressAt: s.now, transferredBytes: 0, state: "planned" };
    s.requests[requestId] = work;
    for (const item of items) claimed.add(item.id);
    if (p) { dispatch(s, p, work, commands); continue; }
    const budget = contentCost(q, items), reserved = reserve(q.fees, items.length);
    const count = items.filter(item => item.kind === "block").length;
    const command: Command = { ...base(s, "work-assigned"), type: "open", poolId,
      sellerId: id, sessionId: q.sessionId, quote: clone(q), amount: String(budget + reserved),
      contentBudget: String(budget), reserve: String(reserved), openingFee: q.fees.opening,
      blockCapacity: count, requestId, contentIds: [...work.contentIds] };
    work.commandId = command.commandId;
    s.pools[poolId] = { id: poolId, taskId: s.taskId, sellerId: id, sessionId: q.sessionId,
      quote: clone(q), openingFee: q.fees.opening, fees: clone(q.fees), amount: command.amount, committed: "0", blockCapacity: count, purchasedBlocks: 0,
      funding: "opening", scheduling: "idle", openCommandId: command.commandId,
      closeCommandId: null, requestId, drainReason: null, returned: null, refundAvailable: false,
      openingObserved: false };
    commands.push(command);
  }

  const discovery = s.quoteDiscovery;
  if (s.intent === "run" && !s.failure && !complete && !awaitingManifest
    && discovery?.enabled && !discovery.pendingCommandId && (!discovery.requested || discovery.armed)
    && !validQuotes(s).length && pendingContent(s).some(item => !claimed.has(item.id))) {
    const command: Command = { ...base(s, "quotes-unavailable"), type: "discover" };
    discovery.pendingCommandId = command.commandId; discovery.requested = true; discovery.armed = false;
    commands.push(command);
  }
  if (s.failure) for (const p of Object.values(s.pools).filter(live)) drain(s, p, commands, s.failure.code);
  for (const p of Object.values(s.pools)) {
    if (p.funding !== "open" || p.requestId || p.scheduling !== "draining") continue;
    const command: Command = { ...base(s, p.drainReason ?? "drain-complete"), type: "close", poolId: p.id, committed: p.committed };
    p.funding = "closing"; p.closeCommandId = command.commandId; commands.push(command);
  }
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
  if (!debugEnabled()) return stepKernel(previous, event);
  debugLog("operation.start", () => ({ operation: "step", input: event, state: previous }));
  try {
    const result = stepKernel(previous, event);
    debugLog("operation.finish", () => ({ operation: "step", result }));
    return result;
  } catch (error) {
    debugLog("operation.rejected", () => ({ operation: "step", reason: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}
function stepKernel(previous: State, event: Event): Result {
  identity(event.eventId);
  if (event.taskId !== previous.taskId || !event.eventId) throw new Error("Wrong task event");
  integer(event.receivedAt); integer(event.occurredAt);
  if (event.occurredAt > event.receivedAt) throw new Error("Event received before occurrence");
  if (previous.seenEvents[event.eventId]) return { state: previous, commands: [], view: view(previous), nextWakeAt: nextWakeAt(previous) };
  if (event.receivedAt < previous.now) throw new Error("Receive clock moved backwards");
  const s = clone(previous);
  s.now = event.receivedAt; s.revision++; s.seenEvents[event.eventId] = true;
  reduce(s, event);
  const reviewed = event.type === "delivery" && previous.requests[event.requestId]?.state !== "settled"
    ? previous.pools[previous.requests[event.requestId]?.poolId]?.sellerId : undefined;
  const commands = plan(s, reviewed);
  return { state: s, commands, view: view(s), nextWakeAt: nextWakeAt(s) };
}
