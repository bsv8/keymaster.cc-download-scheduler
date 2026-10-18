# keymaster.cc-download-scheduler

独立的文件采购策略器。以文件任务为主线，管理多个卖家的下载分配和费用池；支持价格优先、速度优先，以及联合工作的价格上限、目标总速率两个控制杆。

运行时零依赖。内核不访问时钟、网络、钱包、数据库或主项目；不签名或广播交易。测试与外围模拟在独立工程仓库中。

## 构建

Node.js 22，TypeScript 5.9。安装开发依赖后运行 `npm run build`；输出到 `dist/`。也可以使用已有 TypeScript 编译器运行 `tsc -p tsconfig.json`。

```ts
import { createTask, step, restoreTask } from 'keymaster.cc-download-scheduler';

// config 的金额、并发和时间参数由宿主显式提供；没有隐式提高购买授权。
let state = createTask({
  taskId: 'purchase-1', seedHash: 'file-seed-hash',
  preference: 'price', manifestKnown: true,
  content: [{ id: 'block-hash-1', kind: 'block', bytes: 262144 }],
  config: {
    maxBlockPrice: '10', maxTotalSpend: '1000', maxPools: 3,
    poolBlocks: 8, batchBlocks: 3, sampleWindowMs: 30000,
    sampleMaxAgeMs: 10000, requestTimeoutMs: 30000,
    recoveryRetryMs: 5000, retryMs: 1000,
  },
});

const result = step(state, {
  type: 'start', eventId: 'event-1', taskId: state.taskId,
  occurredAt: 0, receivedAt: 0,
});
state = result.state;
// result.commands：交给宿主执行；result.view：UI 投影。
// result.nextWakeAt：由宿主安排下一次 tick，内核不会真实等待。
const restored = restoreTask(JSON.parse(JSON.stringify(state)));
```

金额为规范十进制整数 sats 字符串，速度为 bytes/s，时间为宿主提供的单调毫秒。价格杆值为 sats/完整块，速度杆值为正整数 bytes/s；暂停使用显式 `pause` 事件。报价可声明尾块价，否则使用整数向上取整的按长度计价。

## 控制与执行契约

- `slider` 事件只把指定杆转为手动；`automatic` 只恢复指定杆。`view` 同时返回 manualValue、recommended、effective 和 range，recommended 可用于显示红点。
- `preference` 切换自动建议取舍，不清除手动值。`limits` 是宿主显式授权变更，不是自动推荐的输出。
- 钱包快照必须带修订号及 `reflectedCommands`：哪些开池命令的占用已经包含在 available 中。仅修订号变新不能证明本地占用已被反映。
- `opened` 表示执行层已验证池可用于请求；`closed` 表示可信关闭结果；`refund-available` 和钱包新快照分别说明回收可用及余额。内核不会提前把回收额加到余额。
- `delivery` 必须是已经验收内容、付款责任已经对清的执行事实；未确定结果使用 `unknown` 或 `request-rejected` 的 `safeToRetry: false`，不能先报成功。
- `reconciled: close-rejected` 只用于已经确认原关闭未执行、无未决关闭责任的结果；仅看到池尚未花费不足以授权重发。
- 报价更新的 version 对同卖家单调递增；旧池保留绑定报价。`fees` 更新必须由宿主确认适用于该池合同，不能无条件套用全局新仲裁价格。
- 宿主应原子持久化新状态与命令 outbox，再执行命令，按 commandId 幂等。重启后用 restoreTask 恢复，未决命令由 outbox 对账或重投；内核不会自动重发已登记命令。
- 执行前核对实体命令归属、最新停止意图、合同、费用版本、资金和内容授权；revision 是决策依据，不能简单要求整个任务 revision 永远不变。

`view` 将执行、内容、资金分为三条状态轴；文件完成不代表资金已结清，池关闭不代表文件完整。费用预留和实际支出分别展示；剩余内容估价不是未来总支出承诺。

## 独立测试与模拟

在同级 `BSV8_Engineering` 目录运行（先安装该工程已有开发依赖）：

```sh
node test/keymaster.cc-download-scheduler/run.mjs
node test/keymaster.cc-download-scheduler/run.mjs --simulate --profile market --seed 372
node test/keymaster.cc-download-scheduler/run.mjs --simulate --count 100 --seed 1 --out /tmp/scheduler-stress.json
node test/keymaster.cc-download-scheduler/run.mjs --simulate --profile hours --out /tmp/scheduler-hours.json
node test/keymaster.cc-download-scheduler/run.mjs --simulate --replay /tmp/scheduler-hours.json
```

外围模拟包含独立资金和内容账本、虚拟时钟、可复现速度/延迟/价格抖动、共享带宽、动态卖家和费用变化。`--scenario path.json` 可运行自定义配置；失败保存完整轨迹，`--minimize` 可缩减场景输入。

当前版本尚未接入 keymaster.cc，也不修改其采购、签名、交易或历史记录。自动价格偏好采用当前低价档，自动速度偏好采用授权范围内的速度组合；具体参数和接入边界见工程文档，不承诺动态未知市场的全局最优解。
