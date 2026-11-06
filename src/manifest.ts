/**
 * 文件信息（manifest）校验与长度推导，创建任务、manifest 事件与恢复快照共用同一套规则。
 *
 * 模型：固定块大小 + 尾块；块 i 的长度为 min(blockBytes, fileBytes - i × blockBytes)。
 * 完整有序清单含重复位置；同一 hash 在各位置推导的长度必须一致，否则拒绝。
 */
import { identity, integer } from "./math.js";
import type { Manifest } from "./types.js";

export interface DerivedFileInfo {
  /** 归一化后的清单（深拷贝）。 */
  manifest: Manifest;
  /** 去重后的块 id → 推导字节数。 */
  blocks: Map<string, number>;
}

/** 正长度/零长度文件的块数（与 `(bytes - 1) / blockBytes + 1` 一致，0 字节返回 0）。 */
export function blockCount(fileBytes: number, blockBytes: number): number {
  integer(fileBytes, 0);
  integer(blockBytes, 1);
  return fileBytes === 0 ? 0 : Math.floor((fileBytes - 1) / blockBytes) + 1;
}

/** 第 index 块的长度；调用方保证 index 在清单范围内。 */
export function blockBytesAt(fileBytes: number, blockBytes: number, index: number): number {
  return Math.min(blockBytes, fileBytes - index * blockBytes);
}

/**
 * 校验并推导文件信息；任何不一致抛错，调用方负责保证原状态不变。
 * `blockHashes` 必须是全部块（含重复位置），不能只传剩余块。
 */
export function deriveFileInfo(seedHash: string, fileBytes: number, blockBytes: number, blockHashes: string[]): DerivedFileInfo {
  identity(seedHash);
  integer(fileBytes, 0);
  integer(blockBytes, 1);
  if (!Array.isArray(blockHashes)) throw new Error("Invalid manifest");
  const expected = blockCount(fileBytes, blockBytes);
  if (blockHashes.length !== expected) throw new Error("Manifest block count mismatch");
  const blocks = new Map<string, number>();
  for (let index = 0; index < blockHashes.length; index += 1) {
    const hash = identity(blockHashes[index]);
    if (hash === seedHash) throw new Error("Invalid manifest");
    const size = blockBytesAt(fileBytes, blockBytes, index);
    const previous = blocks.get(hash);
    if (previous !== undefined && previous !== size) throw new Error("Conflicting content identity");
    blocks.set(hash, size);
  }
  return { manifest: { fileBytes, blockBytes, blockHashes: [...blockHashes] }, blocks };
}

/**
 * 组合校验创建/manifest 输入：`fileBytes/blockBytes/blockHashes` 三者同给或同省；
 * `reusedBlockHashes` 必须都属于清单的唯一块集合。
 */
export function parseFileInfo(seedHash: string, input: {
  fileBytes?: number;
  blockBytes?: number;
  blockHashes?: string[];
  reusedBlockHashes?: string[];
}): { derived: DerivedFileInfo; reused: string[] } | null {
  const { fileBytes, blockBytes, blockHashes, reusedBlockHashes } = input;
  const provided = [fileBytes, blockBytes, blockHashes].filter(value => value !== undefined).length;
  if (reusedBlockHashes !== undefined && !Array.isArray(reusedBlockHashes)) throw new Error("Invalid manifest");
  if (provided === 0) {
    if (reusedBlockHashes !== undefined) throw new Error("Invalid manifest");
    return null;
  }
  if (provided !== 3) throw new Error("Invalid manifest");
  const derived = deriveFileInfo(seedHash, fileBytes!, blockBytes!, blockHashes!);
  const reused = [...new Set(reusedBlockHashes ?? [])];
  for (const id of reused) {
    identity(id);
    if (!derived.blocks.has(id)) throw new Error("Unknown reused content");
  }
  return { derived, reused };
}

/** manifest 事件的完整性对比：只有清单完全相同（含顺序与重复次数）才算同一份文件信息。 */
export function sameManifest(a: Manifest, b: Manifest): boolean {
  return a.fileBytes === b.fileBytes && a.blockBytes === b.blockBytes
    && a.blockHashes.length === b.blockHashes.length
    && a.blockHashes.every((hash, index) => hash === b.blockHashes[index]);
}
