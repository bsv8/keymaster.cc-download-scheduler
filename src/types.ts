/** 金额使用规范十进制聪字符串；快照不包含BigInt、时钟或资源句柄。 */
export type Sats = string;
export interface Content { id: string; kind: "seed" | "block"; bytes: number }
export interface Fees {
  version: number;
  opening: Sats;
  settlement: Sats;
  arbitrationBase: Sats;
  arbitrationPerItem: Sats;
}
export interface Quote {
  id: string; version: number; sellerId: string; sessionId: string;
  expiresAt: number; blockPrice: Sats; seedPrice: Sats; blockBytes: number;
  /** 可选的协议尾块报价；未提供时按字节比例向上取整。 */
  tailPrice?: Sats;
  maxBlocks: number; fees: Fees;
  /** 未指定时表示拥有全部内容；已开池保留绑定价格。 */
  contentIds?: string[];
}
export interface Config {
  /** 系统缺省块价：只是任务未单独设置时使用的缺省值，不是授权上限。 */
  maxBlockPrice: Sats;
  /** 在席卖家数上限的基础名额。 */
  baseSeats: number;
  /** 浮动位：在席且没有有效速度档案的卖家不超过该数量。 */
  floatingSeats: number;
  /** 一个费用池 = 一批 = 一次请求的块数上限，同时是派发粒度。 */
  poolBlocks: number;
  sampleWindowMs: number;
  sampleMaxAgeMs: number;
  requestTimeoutMs: number;
  recoveryRetryMs: number;
  retryMs: number;
  /** 合同费用由外围计算，这些参数使用外部提供的估算值。 */
  /** 可选的已知接收端共享带宽上限，不代表对未知链路的保证。 */
  receiveBytesPerSecond?: number;
}
export interface Slider {
  mode: "auto" | "manual";
  manualValue: string | null;
}
export interface Sample { start: number; end: number; bytes: number }
export interface Seller {
  id: string; online: boolean; quote: Quote | null;
  samples: Sample[]; blockedUntil: number;
  /** 确定失败立即拉黑本任务，永不再选；优先于"重新报价可回归"。 */
  blacklisted: boolean;
  /** 确定失败累计次数，供审计与展示。 */
  failureCount: number;
  /** 最近一次"全程零进度"的时间；窗口内按 0 速参与名次，不算"无档案新人"。 */
  zeroSpeedAt: number | null;
}
export type PoolFunding = "opening" | "open" | "closing" | "closed" | "failed" | "recovery";
export interface Pool {
  id: string; taskId: string; sellerId: string; sessionId: string;
  quote: Quote; fees: Fees; amount: Sats; committed: Sats; blockCapacity: number; purchasedBlocks: number;
  funding: PoolFunding; scheduling: "idle" | "serving" | "draining" | "retired";
  openCommandId: string; closeCommandId: string | null;
  requestId: string | null; drainReason: string | null;
  returned: Sats | null; refundAvailable: boolean; openingObserved: boolean;
  recoveryAt: number; recoveryCommandId: string | null;
  /** 责任持续占用，直到明确的执行结果允许释放。 */
  walletRevisionAtIntent: number;
}
export interface Request {
  id: string; commandId: string; poolId: string; contentIds: string[];
  prices: Record<string, Sats>; startedAt: number; lastProgressAt: number;
  transferredBytes: number; state: "pending" | "unresolved" | "settled" | "rejected";
}
export interface State {
  version: 1; taskId: string; seedHash: string; revision: number; sequence: number; now: number;
  config: Config; intent: "ready" | "run" | "pause" | "cancel";
  price: Slider;
  /** 当前持有席位的卖家；池关闭与重开之间保持，只在席位评审时变更。 */
  seats: string[];
  manifestKnown: boolean; content: Record<string, Content>;
  completed: Record<string, "reused" | "purchased">;
  sellers: Record<string, Seller>; pools: Record<string, Pool>; requests: Record<string, Request>;
  wallet: { revision: number; available: Sats; reflectedCommands: string[] };
  spent: Sats; actualSamples: Sample[]; seenEvents: Record<string, true>;
}
export type Payload =
  | { type: "start" | "pause" | "resume" | "cancel" | "tick" }
  | { type: "limits"; maxBlockPrice?: Sats; baseSeats?: number; floatingSeats?: number; receiveBytesPerSecond?: number }
  | { type: "slider"; slider: "price"; value: string }
  | { type: "automatic"; slider: "price" }
  | { type: "manifest"; content: Content[]; reused?: string[] }
  | { type: "quote"; quote: Quote }
  | { type: "seller"; sellerId: string; online: boolean }
  | { type: "wallet"; revision: number; available: Sats; reflectedCommands: string[] }
  | { type: "fees"; poolId: string; fees: Fees }
  | { type: "opened"; poolId: string; commandId: string }
  | { type: "open-failed"; poolId: string; commandId: string; released: boolean }
  | { type: "unknown"; poolId: string; commandId: string }
  | { type: "progress"; requestId: string; bytes: number }
  /** 可信执行结果：接受的内容必须已验收，且付款责任已对清。 */
  | { type: "delivery"; requestId: string; accepted: string[]; paid: Sats; startedAt: number; endedAt: number }
  | { type: "request-rejected"; requestId: string; safeToRetry: boolean }
  | { type: "closed"; poolId: string; commandId: string; returned: Sats; spent: Sats }
  | { type: "refund-available"; poolId: string }
  | { type: "reconciled"; poolId: string; commandId: string; outcome: "close-rejected" | "opening-failed" };
export type Event = Payload & {
  eventId: string; taskId: string; occurredAt: number; receivedAt: number;
};
export interface CommandBase {
  commandId: string; taskId: string; revision: number; reason: string;
}
export type Command = CommandBase & (
  | { type: "open"; poolId: string; sellerId: string; sessionId: string; quote: Quote;
      amount: Sats; contentBudget: Sats; reserve: Sats; openingFee: Sats; walletRevision: number; blockCapacity: number }
  | { type: "download"; poolId: string; requestId: string; contentIds: string[];
      prices: Record<string, Sats>; maxPayment: Sats; priceLimit: Sats; feeVersion: number }
  | { type: "drain"; poolId: string }
  | { type: "close"; poolId: string; committed: Sats }
  | { type: "reconcile"; poolId: string; requestId: string | null }
);
export interface SliderView {
  mode: "auto" | "manual"; manualValue: string | null;
  /** 有效值：手动值优先，否则系统缺省。v1 没有自动建议红点。 */
  effective: string;
  /** 市场已报价区间，只作事实展示。 */
  range: { min: string; max: string } | null;
}
export interface View {
  taskId: string; revision: number;
  execution: "ready" | "running" | "waiting" | "paused" | "stopping" | "stopped" | "finished";
  content: "manifest-unknown" | "incomplete" | "complete";
  funds: "none" | "pending" | "settled" | "recovery-required";
  price: SliderView;
  sellerSpeeds: Record<string, { bytesPerSecond: number | null; samples: number; lastAt: number | null; zeroSpeed: boolean }>;
  actualBytesPerSecond: number; sustainableBytesPerSecond: number;
  /** 只陈述事实的准入与在途统计，不做任何无数据来源的预测。 */
  facts: {
    eligible: number; aboveCeiling: number; measured: number;
    unmeasuredEligible: number; zeroSpeed: number; blacklisted: number; inFlight: number;
  };
  completed: number; total: number; reasons: string[];
  money: { spent: Sats; locked: Sats; committed: Sats; pendingReturn: Sats; arbitrationReserved: Sats; settlementReserved: Sats };
  /** 按报价估算的内容费区间，不承诺未来支出；其他费用分开展示。 */
  estimatedRemainingContent: { min: Sats; max: Sats } | null;
}
export interface Result { state: State; commands: Command[]; view: View; nextWakeAt: number | null }
