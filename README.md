# keymaster-trade-scheduler

TypeScript 文件采购策略器，唯一源码位于本仓 `src/`；钱包消费本包，不保留内置副本。运行时零依赖，不访问真实时钟、网络、钱包或数据库，不执行签名和广播。Go 唯一实现位于本仓根目录 `scheduler/`，`go.mod` 位于仓库根目录，module `github.com/bsv8/keymaster.cc-download-scheduler`；CLI 消费该模块，不保留内部副本。两语言遵循同一 TS 业务规则，不允许独立演进。

## 构建与使用

Node.js 22、TypeScript 5.9。本仓运行 `pnpm install && pnpm build`，或使用 TypeScript 编译器执行 `tsc -p tsconfig.json`，输出到 `dist/`；消费前先构建，包导出仅指向 `dist/`。cc 使用已发布的精确 npm 版本 `keymaster-trade-scheduler@0.1.0`，不使用本地 `file:` 或源码 alias；Go 目录整理不改变 npm 包。Go 在仓库根目录运行 `go build ./...`，仅依赖标准库；Go 使用根标签 `v0.1.1` 发布，不使用 `go/v...`；导入 `github.com/bsv8/keymaster.cc-download-scheduler/scheduler`，构建不依赖 Node.js。

```ts
import { createTask, step, restoreTask } from 'keymaster-trade-scheduler';

let state = createTask({
  taskId: 'purchase-1', seedHash: 'file-seed-hash', manifestKnown: true,
  content: [{ id: 'block-hash-1', kind: 'block', bytes: 262144 }],
  config: {
    maxBlockPrice: '10', // 未设置任务价格杆时的缺省完整块最高价
    baseSeats: 6, floatingSeats: 2,
    poolBlocks: 4, // 单次请求上限，不限制池的累计购买量
    requestTimeoutMs: 5000, // 无新字节的停摆时限
  },
});
const result = step(state, {
  type: 'start', eventId: 'event-1', taskId: state.taskId,
  occurredAt: 0, receivedAt: 0,
});
state = result.state;
const restored = restoreTask(JSON.parse(JSON.stringify(state)));
```

金额是规范十进制整数 sats 字符串；速度为 bytes/s；时间由宿主注入。`step` 不修改输入，返回 `state / commands / view / nextWakeAt`。宿主原子保存状态和命令 outbox，之后按 `commandId` 幂等执行，并输入经过验证的结果。

## 策略

- 最高完整块价决定准入；上限内速度优先，不选择便宜卖家弥补资金不足，不提供价格偏好、任务总支出授权或自动价格建议。
- 席位上限为基础名额加浮动名额；未测速在席数不超过浮动名额。速度按长期累计有效块字节除以累计耗时计算，未测速与已测零速不同。
- 每次购买结果明确后，只评审对应卖家，按基础排名及候补一换一；其他在途卖家不被打断，没有全局轮次。
- 先安排卖家及具体内容，再配资金。工作进入 `planned` 后即排他占用内容；池可用后执行同一份工作。
- 已测在席卖家按累计速度降序获得工作和资金；未测速者按可重放随机顺序。
- 请求逐块缩量，完整成本包括内容、适用仲裁和结算预留；新池另加开池费。现有池按面额减已承诺金额计算容量，不用预计回款。
- 池不受累计块数限制。金额足够可多次购买；池和报价分开，请求保存自己的报价。`pool-available` 可以输入没有开池报价的既存池及累计付款事实。
- 最小有效购买也付不起时记录持久 `failure: insufficient-funds`。同次状态提交中此前已分配的可支付工作保留，之后不新增分配；已有工作完成和资金结算继续。充值、resume 或内容齐全不能清除此错误。
- 停摆或不可安全重试拒绝不证明授权责任消失：请求保留 `unresolved` 和内容归属，池进入 `problem`，不自动关池或重买。开池未知可解除尚未形成购买授权的计划，但保留问题池及资金占用。可信晚到结果仍可记录。
- 内容完成、退出、枯竭或错误后的关闭由内核输出。执行层仍验证合同、费用版本、资金、内容、签名和历史责任；不能自行改金额、换卖家、补池或续购。

## 输入输出契约

- 命令为 `discover / open / download / drain / close`；`discover` 是保留的报价发现候选接口，钱包尚未接入，不能视为已确定的自动重查政策。`open` 携带排他的 `requestId / contentIds`；`download` 携带独立报价、逐项价格及最大付款。
- 钱包事实包含修订号、余额和 `reflectedCommands`。仅修订号更新不能释放未反映的本地资金占用。
- `opened / pool-available` 是真实可用池事实；`delivery` 是内容已验收、付款责任已明确的事实。
- `closed / refund-available / wallet` 分别确认关闭、回款可用和真实钱包余额；内核不自行把预计回款加入余额。
- `fees` 只能输入确实适用于对应池的费用事实。池合同变化不能由宿主静默改写命令。
- `view` 分开表达执行、内容和资金状态，并保留任务失败原因。仲裁和结算预留不属于实际支出。
- 快照和幂等记录可重放；未决命令由 outbox 对账，恢复不会自动重发历史命令或清除责任。

## 独立验证

从工程仓库运行：

```sh
node test/shared/download-scheduler/run.mjs
node test/shared/download-scheduler/run.mjs --simulate --profile market --seed 372
SCHEDULER_SEEDS=100 node test/keymaster.cc-cli/scheduler/run.mjs
```

`npm run test:components:parity` 是工程仓的双组件开发源码交叉门禁，不代替发布版验收；`npm run test:components:released` 检查真实产品的发布依赖和 CLI 编译。调度器交叉测试逐步比较完整状态、命令、视图、唤醒和完整错误文本，拒绝事件不得修改输入；还将双方快照交换后续跑，与原轨迹逐步比较，不只各自恢复自己的快照。

独立模型测试不等于真实钱包、协议和链上集成通过，也不是所有输入的穷尽证明。当前能力及执行层边界见工程仓库 `docs/shared/download-scheduler/当前实现.md`。
