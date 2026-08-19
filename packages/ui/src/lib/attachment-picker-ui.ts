/**
 * 附件选择 UI 辅助 — 主进程 dialog 选择 + 拖拽文件读取
 *
 * 文件读取走主进程（token 授权），渲染进程不直接访问文件系统。
 */

import { DialogService } from "../services/dialog.service";
import { parseFile, mimeFromName, type PendingAttachment } from "./file-parser";

/** 通过主进程 dialog 选择文件并解析 */
export async function pickAndParseFiles(): Promise<PendingAttachment[]> {
  const result = await DialogService.openFile();
  if (!result || result.token === "" || result.files.length === 0) {
    if (result?.error) throw new Error(result.error);
    return [];
  }
  try {
    const attachments: PendingAttachment[] = [];
    for (const fileMeta of result.files) {
      const bytes = await DialogService.readPickedFile(result.token, fileMeta.path);
      // 显式传 type：主进程 File 构造默认 type 为空，会导致 data URL 无 image/xxx MIME 被校验拒绝
      const file = new File([bytes], fileMeta.name, { type: mimeFromName(fileMeta.name) });
      const attachment = await parseFile(file, fileMeta.path);
      attachment.size = fileMeta.size;
      attachments.push(attachment);
    }
    return attachments;
  } finally {
    await DialogService.releasePickedFiles(result.token).catch(() => {});
  }
}

/** 拖拽文件解析（浏览器 File 对象，Electron 下带 path） */
export async function parseDroppedFiles(files: File[]): Promise<PendingAttachment[]> {
  const attachments: PendingAttachment[] = [];
  for (const file of files) {
    // 优先官方 API webUtils.getPathForFile；File.path 兼容兜底（Electron 32 已弃用）
    const raw = file as File & { path?: string };
    const path = window.electronAPI?.getPathForFile?.(file) || raw.path || undefined;
    const attachment = await parseFile(file, path);
    attachments.push(attachment);
  }
  return attachments;
}

/** 待发送文件元数据（文本/Office 存路径引用） */
export interface PendingFileRef {
  name: string;
  path?: string;
  kind: PendingAttachment["kind"];
}

/**
 * 把解析后的附件转换为发送内容。
 * - 图片/PDF → images 数组（base64）
 * - 文本/Office → files 路径引用（不内联内容，由 core 读取/解析）
 * - 不支持 → rejected
 */
export function buildSendContent(
  attachments: PendingAttachment[],
  userText: string,
): { displayText: string; files: PendingFileRef[]; images: string[]; rejected: PendingAttachment[] } {
  const images: string[] = [];
  const files: PendingFileRef[] = [];
  const rejected: PendingAttachment[] = [];
  const fileTags: string[] = [];

  for (const att of attachments) {
    if (att.kind === "image") {
      images.push(att.data);
      continue;
    }
    if (att.kind === "pdf") {
      // PDF 走视觉桥：作为图片发送（模型视觉能力处理）
      images.push(att.data);
      continue;
    }
    if (att.error) {
      rejected.push(att);
      continue;
    }
    // 文本 / Office / 未知（任意文件）：存路径引用，消息区域只显示卡片，Agent 用 read_file 读取
    files.push({ name: att.name, path: att.path, kind: att.kind });
    fileTags.push(`📎 ${att.name}`);
  }

  const joined = [userText, ...fileTags].filter(Boolean).join("\n");
  return { displayText: joined || "请查看以下内容：", files, images, rejected };
}
