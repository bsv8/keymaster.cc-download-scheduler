export * from "./types.js";
export { createTask, step, restoreTask } from "./scheduler.js";
/** 供宿主与外围模拟复用同一份"有效速度档案"定义，避免各自实现漂移。 */
export { hasArchive, needsProbe, sellerSpeed, effectivePrice, seatCap, unmeasuredCap, view } from "./recommend.js";
/** 宿主重建唤醒定时器用；与 `step` 返回的 nextWakeAt 使用同一实现。 */
export { nextWakeAt } from "./scheduler.js";
