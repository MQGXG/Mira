/**
 * 附件授权机制 — 参考 opencode attachment-picker
 *
 * 用户通过主进程 dialog 选择文件后，仅返回 token + 文件元数据（路径/名称/大小），
 * 渲染进程不直接持有文件系统访问权。读取文件时必须携带 token，
 * 由主进程校验 sender（窗口）与路径是否属于本次选择，并扣减 20MB 总预算。
 */

import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB 总预算

interface Selection {
  sender: number;
  paths: Set<string>;
  remaining: number;
}

const selections = new Map<string, Selection>();

/** 记录一次文件选择，返回授权 token */
export function createAttachmentSelection(sender: number, paths: string[]): string {
  const token = randomUUID();
  selections.set(token, { sender, paths: new Set(paths), remaining: MAX_ATTACHMENT_BYTES });
  return token;
}

/** 校验附件总预算（选择时提前拒绝超限） */
export function assertAttachmentBudget(files: { size: number }[]): void {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件总大小超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 限制`);
  }
}

/** 按 token + sender 校验并读取文件，扣减预算 */
export async function readAttachment(
  sender: number,
  token: string,
  filePath: string,
): Promise<ArrayBuffer> {
  const selection = selections.get(token);
  if (!selection || selection.sender !== sender) {
    throw new Error("附件授权无效或已过期");
  }
  if (!selection.paths.has(filePath)) {
    throw new Error("文件不在本次选择范围内");
  }

  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    if (info.size > selection.remaining) {
      throw new Error("附件超过剩余预算");
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < info.size) {
      const result = await file.read(bytes, offset, info.size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    selection.remaining -= offset;
    // 全部读取完毕后自动释放授权
    if (selection.paths.size === 0) selections.delete(token);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + offset);
  } finally {
    await file.close();
  }
}

/** 释放授权（用户取消/不再需要时） */
export function releaseAttachmentSelection(sender: number, token: string): void {
  const selection = selections.get(token);
  if (selection?.sender === sender) selections.delete(token);
}
