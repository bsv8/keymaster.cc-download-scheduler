export * from "./types.js";
export { createTask, step, restoreTask } from "./scheduler.js";
/** 供宿主与外围模拟复用同一份"有效速度档案"定义，避免各自实现漂移。 */
export { hasArchive, needsProbe, sellerSpeed, effectivePrice, seatCap, unmeasuredCap } from "./recommend.js";
