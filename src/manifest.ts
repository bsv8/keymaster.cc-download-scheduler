/**
 * 文件信息（manifest）校验，创建任务、manifest 事件与恢复快照共用同一套规则。
 *
 * 模型：完整有序块哈希清单（含重复位置），不保存长度，不推导块数与尾块长度。
 * 内容身份只看 Hash；重复出现仍是同一采购对象，不因位置不同产生多份责任。
 */
import { identity } from "./math.js";
import type { Manifest } from "./types.js";

export interface DerivedFileInfo {
  /** 归一化后的清单（深拷贝）。 */
  manifest: Manifest;
  /** 去重后的块 id 集合（首次出现顺序）。 */
  blocks: Set<string>;
}

/**
 * 校验清单；任何不一致抛错，调用方负责保证原状态不变。
 * `blockHashes` 必须是全部块（含重复位置），不能只传剩余块。
 */
export function deriveFileInfo(seedHash: string, blockHashes: string[]): DerivedFileInfo {
  identity(seedHash);
  if (!Array.isArray(blockHashes)) throw new Error("Invalid manifest");
  const blocks = new Set<string>();
  for (let index = 0; index < blockHashes.length; index += 1) {
    const hash = identity(blockHashes[index]);
    if (hash === seedHash) throw new Error("Invalid manifest");
    blocks.add(hash);
  }
  return { manifest: { blockHashes: [...blockHashes] }, blocks };
}

/**
 * 校验复用声明：`reusedBlockHashes` 必须都属于清单的唯一块集合。
 * 身份错误保持 `Invalid identity`，不统一改为 `Invalid manifest`。
 */
function parseReused(blocks: Set<string>, reusedBlockHashes?: string[]): string[] {
  if (reusedBlockHashes !== undefined && !Array.isArray(reusedBlockHashes)) throw new Error("Invalid manifest");
  const reused = [...new Set(reusedBlockHashes ?? [])];
  for (const id of reused) {
    identity(id);
    if (!blocks.has(id)) throw new Error("Unknown reused content");
  }
  return reused;
}

/**
 * 组合校验创建输入：省略 `resume` 表示清单未知；提供时 `blockHashes` 必填，
 * `[]` 表示已知没有正文块。
 */
export function parseResume(seedHash: string, resume?: {
  blockHashes?: string[];
  reusedBlockHashes?: string[];
}): { derived: DerivedFileInfo; reused: string[] } | null {
  if (resume === undefined) return null;
  if (resume === null || typeof resume !== "object") throw new Error("Invalid manifest");
  if (!Array.isArray(resume.blockHashes)) throw new Error("Invalid manifest");
  const derived = deriveFileInfo(seedHash, resume.blockHashes);
  return { derived, reused: parseReused(derived.blocks, resume.reusedBlockHashes) };
}

/** 组合校验 manifest 事件：`blockHashes` 必填，`[]` 表示已知没有正文块。 */
export function parseManifestPayload(seedHash: string, input: {
  blockHashes?: string[];
  reusedBlockHashes?: string[];
}): { derived: DerivedFileInfo; reused: string[] } {
  if (!Array.isArray(input.blockHashes)) throw new Error("Invalid manifest");
  const derived = deriveFileInfo(seedHash, input.blockHashes);
  return { derived, reused: parseReused(derived.blocks, input.reusedBlockHashes) };
}

/** 清单末项 Hash 对应的唯一采购对象；空清单或未知清单返回 null。 */
export function tailBlockId(manifest: Manifest | null): string | null {
  if (!manifest || manifest.blockHashes.length === 0) return null;
  return manifest.blockHashes[manifest.blockHashes.length - 1]!;
}

/** manifest 事件的完整性对比：只有清单完全相同（含顺序与重复次数）才算同一份文件信息。 */
export function sameManifest(a: Manifest, b: Manifest): boolean {
  return a.blockHashes.length === b.blockHashes.length
    && a.blockHashes.every((hash, index) => hash === b.blockHashes[index]);
}
