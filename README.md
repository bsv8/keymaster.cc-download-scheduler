# keymaster.cc-download-scheduler

独立的文件采购策略器。以文件任务为主线，维护一组"席位卖家"，管理费用池、下载分配与资金责任；用户只有一根价格杆（每块最高购买价）。

运行时零依赖。内核不访问时钟、网络、钱包、数据库或主项目；不签名或广播交易。测试与外围模拟在独立工程仓库中。

## 构建

Node.js 22，TypeScript 5.9。安装开发依赖后运行 `npm run build`；输出到 `dist/`。也可以使用已有 TypeScript 编译器运行 `tsc -p tsconfig.json`。

```ts
import { createTask, step, restoreTask } from 'keymaster.cc-download-scheduler';

let state = createTask({
  taskId: 'purchase-1', seedHash: 'file-seed-hash', manifestKnown: true,
  content: [{ id: 'block-hash-1', kind: 'block', bytes: 262144 }],
  config: {
    // 系统缺省块价：任务未单独设置时使用，不是授权上限。唯一硬边界是钱包可用余额。
    maxBlockPrice: '10',
    // 席位：基础名额 + 浮动位（在席但无有效速度档案的卖家上限，给新卖家测速用）。
    baseSeats: 8, floatingSeats: 2,
    // 一个费用池 = 一批 = 一次请求的块数上限。
    poolBlocks: 8,
    sampleWindowMs: 30000, sampleMaxAgeMs: 10000,
    requestTimeoutMs: 30000, recoveryRetryMs: 5000, retryMs: 1000,
    // 可选：已知接收端共享带宽上限。
    receiveBytesPerSecond: 5_000_000,
  },
});

const result = step(state, {
  type: 'start', eventId: 'event-1', taskId: state.taskId, occurredAt: 0, receivedAt: 0,
});
state = result.state;
// result.commands：交给宿主执行；result.view：UI 投影。
// result.nextWakeAt：由宿主安排下一次 tick，内核不会真实等待。
const restored = restoreTask(JSON.parse(JSON.stringify(state)));
```

金额为规范十进制整数 sats 字符串，速度为 bytes/s，时间为宿主提供的单调毫秒。报价可声明尾块价，否则使用整数向上取整的按长度计价。

## 策略规则

- **一根价格杆**：每块最高购买价。`price.mode` 默认 `auto`，此时有效值 = `config.maxBlockPrice`；用户拖动后进入 `manual`，可以调得比系统缺省更高或更低。v1 **没有自动建议红点**，`SliderView` 只有 `mode / manualValue / effective / range`（`range` 是市场已报价区间的事实）。
- **杆之下只有一套速度优先策略**：没有 `preference`、没有价格维度、没有任务总支出授权（`maxTotalSpend` 不存在）。
- **席位**：在席上限 = `baseSeats + floatingSeats`；其中没有有效速度档案的卖家不超过 `floatingSeats`。席位未满时报价合格就入场；满员后只在费用池"下载完成、无在途、进入 drain"的时刻评审一次，且**只评审本轮刚进入 drain 的卖家**：名次 ≤ `baseSeats` 保留；名次 > `baseSeats` 时按"闲置有档案最快者 → 随机无档案新人 → 不换"一换一。在途者只参与算名次，不被替换。
- **席位收缩会收敛**：限额变小或档案过期导致浮动位超限时，最差的超额席位退出；退出只做 drain，已确认付款与在途责任照常完成。
- **开池额度** = `min(剩余块, 卖家 maxBlocks, poolBlocks)`；首次只派一个真实所需内容探速，探速同样受池块容量约束；池用尽即关闭，下一轮再决策；买不到任何内容（无 Seed 可买且块数为 0）时不开池，等待资金。
- **任务内黑名单**：内容校验失败或不可重试拒绝 → 立即拉黑本任务，永不再选；全程零进度超时记为"零速事实"（参与名次排最后、不算无档案新人），重新获得机会要在没有其他候选、或在位卖家下线空出席位时。
- 报价更新的 version 对同卖家单调递增；旧池保留绑定报价；被淘汰卖家的档案保留，重新报出更低价格可按价格杆恢复候选。

## 控制与执行契约

- `slider` / `automatic` 只作用于价格杆。`limits` 是宿主显式变更（缺省块价、席位数、接收带宽），不是自动推荐的输出。
- 钱包快照必须带修订号及 `reflectedCommands`：哪些开池命令的占用已经包含在 available 中。仅修订号变新不能证明本地占用已被反映。
- `opened` 表示执行层已验证池可用于请求；`closed` 表示可信关闭结果；`refund-available` 和钱包新快照分别说明回收可用及余额。内核不会提前把回收额加到余额。
- `delivery` 必须是已经验收内容、付款责任已经对清的执行事实；未确定结果使用 `unknown` 或 `request-rejected` 的 `safeToRetry: false`，不能先报成功。
- `reconciled: close-rejected` 只用于已经确认原关闭未执行、无未决关闭责任的结果；仅看到池尚未花费不足以授权重发。
- 报价更新的 version 对同卖家单调递增；`fees` 更新必须由宿主确认适用于该池合同，不能无条件套用全局新仲裁价格。
- 宿主应原子持久化新状态与命令 outbox，再执行命令，按 commandId 幂等。重启后用 restoreTask 恢复，未决命令由 outbox 对账或重投；内核不会自动重发已登记命令。
- 执行前核对实体命令归属、最新停止意图、合同、费用版本、资金和内容授权；revision 是决策依据，不能简单要求整个任务 revision 永远不变。

`view` 将执行、内容、资金分为三条状态轴；文件完成不代表资金已结清，池关闭不代表文件完整。`view.facts` 只陈述合格数、超上限数、已测/未测数、零速数、黑名单数与在途数，不做任何无数据来源的速度或时间预测；费用预留与实际支出分别展示，剩余内容估价不是未来总支出承诺。

## 独立测试与模拟

在同级 `BSV8_Engineering` 目录运行（先安装该工程已有开发依赖）：

```sh
node test/keymaster.cc-download-scheduler/run.mjs
node test/keymaster.cc-download-scheduler/run.mjs --simulate --profile market --seed 372
node test/keymaster.cc-download-scheduler/run.mjs --simulate --count 100 --seed 1 --out /tmp/scheduler-stress.json
node test/keymaster.cc-download-scheduler/run.mjs --simulate --profile hours --out /tmp/scheduler-hours.json
node test/keymaster.cc-download-scheduler/run.mjs --simulate --replay /tmp/scheduler-hours.json
```

外围模拟包含独立资金和内容账本、虚拟时钟、可复现速度/延迟/价格抖动、共享带宽、动态卖家和费用变化，并独立断言席位上限、浮动位限位、池块容量与资金守恒。`--scenario path.json` 可运行自定义配置；失败保存完整轨迹，`--minimize` 可缩减场景输入。

当前版本尚未接入 keymaster.cc，也不修改其采购、签名、交易或历史记录。规则细节与边界见工程仓库 `docs/keymaster.cc-download-scheduler/`。
