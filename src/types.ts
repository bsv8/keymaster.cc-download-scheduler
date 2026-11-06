/** 金额使用规范十进制聪字符串；快照不包含BigInt、时钟或资源句柄。 */
export type Sats = string;
/**
 * 一个可计价的内容对象。内容身份只看 Hash，不保存字节数；
 * 验收后的实际字节是执行统计，只用于测速，不参与身份和完成判定。
 */
export interface Content { id: string; kind: "seed" | "block" }
/** 文件结构：完整有序块哈希清单（含重复位置）。`null` 表示种子尚未知。 */
export interface Manifest {
  /** 完整有序块哈希清单；已知空文件时为 []。 */
  blockHashes: string[];
}
export interface Fees {
  version: number;
  opening: Sats;
  settlement: Sats;
  arbitrationBase: Sats;
  arbitrationPerItem: Sats;
}
export interface Quote {
  id: string; version: number; sellerId: string; sessionId: string;
  expiresAt: number; blockPrice: Sats; seedPrice: Sats;
  /** 清单末项 Hash 的报价；未提供时回退到 blockPrice。 */
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
  /** 浮动位：在席且没有速度档案的卖家不超过该数量。 */
  floatingSeats: number;
  /** 单次购买请求块数上限；不是池的累计购买上限。 */
  poolBlocks: number;
  /** 请求停摆超时：连续这么久没有新字节就判停摆，不是整批总时长。 */
  requestTimeoutMs: number;
}
export interface Slider {
  mode: "auto" | "manual";
  manualValue: string | null;
}
export interface Seller {
  id: string; online: boolean; quote: Quote | null;
  /** 累计已验收交付的正文块字节（delivery.acceptedBlockBytes 求和）；有尝试无字节只累计时间。 */
  bytesTotal: number;
  /** 累计传输耗时（毫秒）：成功交付用交付墙钟，失败尝试按请求时长累计。 */
  timeMsTotal: number;
  /** 是否测过速：发生过交付或一次完整尝试（含停摆）即为 true。 */
  measured: boolean;
  /** 最近一次交付或失败尝试结束的时刻。 */
  lastAt: number | null;
  /** 确定失败立即拉黑本任务，永不再选；优先于"重新报价可回归"。 */
  blacklisted: boolean;
  /** 确定失败累计次数，供审计与展示。 */
  failureCount: number;
}
/** 池资金状态；`problem` 表示结果未知或资金待清理，已移出任务调度，由宿主记录并事后处理。 */
export type PoolFunding = "opening" | "open" | "closing" | "closed" | "failed" | "problem";
export interface Pool {
  id: string; sellerId: string; sessionId: string;
  /** 自动开池时的历史报价，仅供审计，不限制后续购买报价。 */
  quote?: Quote;
  openingFee: Sats;
  fees: Fees; amount: Sats; committed: Sats; blockCapacity: number; purchasedBlocks: number;
  funding: PoolFunding; scheduling: "idle" | "serving" | "draining" | "retired";
  openCommandId: string; closeCommandId: string | null;
  requestId: string | null; drainReason: string | null;
  returned: Sats | null; refundAvailable: boolean; openingObserved: boolean;
}
export interface Request {
  id: string; commandId: string; poolId: string; contentIds: string[];
  /** 本次工作的报价；更换报价不重置费用池累计付款。 */
  quote: Quote;
  prices: Record<string, Sats>; startedAt: number; lastProgressAt: number;
  transferredBytes: number; state: "planned" | "pending" | "unresolved" | "settled" | "rejected";
}
export interface State {
  version: 1; seedHash: string; revision: number; sequence: number; now: number;
  config: Config; intent: "ready" | "run" | "pause" | "cancel";
  /** 终态错误：停止新增工作，但在途和资金责任继续处理。 */
  failure: { code: "insufficient-funds"; sellerId: string; required: Sats } | null;
  /** 宿主是否具备报价查询端口；只由策略发 discover，不在宿主按池寿命重查。
   * 一次查询没有可用报价时不循环重试；新可用报价或显式 resume 才允许下一次。 */
  quoteDiscovery?: { enabled: boolean; armed: boolean; requested: boolean; failed: boolean; pendingCommandId: string | null };
  price: Slider;
  /** 当前持有席位的卖家；池关闭与重开之间保持，只在席位评审时变更。 */
  seats: string[];
  /** 文件结构；`null` 表示种子尚未知（等待 manifest 事件）。 */
  manifest: Manifest | null;
  content: Record<string, Content>;
  completed: Record<string, "reused" | "purchased">;
  sellers: Record<string, Seller>; pools: Record<string, Pool>; requests: Record<string, Request>;
  spent: Sats; seenEvents: Record<string, true>;
}
export type Payload =
  | { type: "start" | "pause" | "resume" | "cancel" | "tick" }
  | { type: "limits"; maxBlockPrice?: Sats; baseSeats?: number; floatingSeats?: number }
  | { type: "slider"; slider: "price"; value: string }
  | { type: "automatic"; slider: "price" }
  | { type: "manifest"; blockHashes: string[]; reusedBlockHashes?: string[] }
  | { type: "quote"; quote: Quote }
  | { type: "quote-source"; enabled: boolean }
  | { type: "quotes-requested" | "quotes-request-failed"; commandId: string }
  | { type: "seller"; sellerId: string; online: boolean }
  | { type: "fees"; poolId: string; fees: Fees }
  /** 宿主验证后的既存池事实，不要求文件或开池报价。 */
  | { type: "pool-available"; poolId: string; sellerId: string; sessionId: string; amount: Sats; committed: Sats; fees: Fees }
  | { type: "opened"; poolId: string; commandId: string }
  | { type: "open-failed"; poolId: string; commandId: string; released: boolean; insufficientFunds?: boolean }
  | { type: "unknown"; poolId: string; commandId: string }
  | { type: "progress"; requestId: string; bytes: number }
  /** 可信执行结果：接受的内容必须已验收，且付款责任已对清。 */
  | { type: "delivery"; requestId: string; accepted: string[]; paid: Sats; acceptedBlockBytes: number; startedAt: number; endedAt: number }
  | { type: "request-rejected"; requestId: string; safeToRetry: boolean }
  | { type: "closed"; poolId: string; commandId: string; returned: Sats; spent: Sats }
  | { type: "refund-available"; poolId: string };
export type Event = Payload & {
  eventId: string; seedHash: string; occurredAt: number; receivedAt: number;
};
export interface CommandBase {
  commandId: string; seedHash: string; revision: number; reason: string;
}
export type Command = CommandBase & (
  | { type: "discover" }
  | { type: "open"; poolId: string; sellerId: string; sessionId: string; quote: Quote;
      amount: Sats; contentBudget: Sats; reserve: Sats; openingFee: Sats; blockCapacity: number; requestId: string; contentIds: string[] }
  | { type: "download"; poolId: string; requestId: string; quote: Quote; contentIds: string[];
      prices: Record<string, Sats>; maxPayment: Sats; priceLimit: Sats; feeVersion: number }
  | { type: "drain"; poolId: string }
  | { type: "close"; poolId: string; committed: Sats }
);
export interface SliderView {
  mode: "auto" | "manual"; manualValue: string | null;
  /** 有效值：手动值优先，否则系统缺省。v1 没有自动建议红点。 */
  effective: string;
  /** 市场已报价区间，只作事实展示。 */
  range: { min: string; max: string } | null;
}
export interface SellerSpeedView {
  /** 累计速度：总字节 ÷ 总时间；未测速为 null，测过但零字节为 0。 */
  bytesPerSecond: number | null;
  measured: boolean;
  bytesTotal: number;
  timeMsTotal: number;
  lastAt: number | null;
}
export interface View {
  seedHash: string; revision: number;
  execution: "ready" | "running" | "waiting" | "paused" | "stopping" | "stopped" | "finished";
  failure: State["failure"];
  content: "manifest-unknown" | "incomplete" | "complete";
  funds: "none" | "pending" | "settled" | "problem";
  price: SliderView;
  sellerSpeeds: Record<string, SellerSpeedView>;
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
/**
 * 创建任务输入。省略 `resume` 时清单未知，内核先购买 Seed；提供 `resume`
 * 时声明宿主已验证本地 Seed，内核跳过购买，只采购缺失块。
 */
export interface CreateTaskInput {
  seedHash: string;
  resume?: {
    /** 完整有序块哈希清单（含重复位置）；[] 表示已知没有正文块。 */
    blockHashes: string[];
    /** 宿主已按本地字节重验的块；只允许属于清单的块。 */
    reusedBlockHashes?: string[];
  };
}
