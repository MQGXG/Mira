/**
 * 附件分类 — 判断文件类型并生成可发送附件（对齐 opencode：文本/Office 存路径引用，不读内容）
 *
 * 分类：
 * - image  → base64（已压缩）→ 视觉链路
 * - pdf    → base64 原样（走视觉桥，零依赖）
 * - text   → 存路径引用（Agent 通过 read_file 工具读取）
 * - excel/word/ppt → 存路径引用（core 发送时解析注入）
 * - unknown→ 存路径引用（任意文件均可上传，Agent 通过 read_file 读取）
 */

import { compressImage } from "./image-compress";

export interface PendingAttachment {
  kind: "image" | "text" | "excel" | "word" | "ppt" | "pdf" | "unknown";
  name: string;
  size: number;
  /** 原始文件路径（文本/Office 存路径引用） */
  path?: string;
  /** 图片/pdf：data URL；文本/Office：空字符串（内容不在此） */
  data: string;
  /** 拒绝原因 */
  error?: string;
}

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv",
  "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "conf",
  "js", "ts", "tsx", "jsx", "py", "rb", "rs", "go", "java", "c", "cpp",
  "h", "hpp", "css", "scss", "sass", "html", "htm", "sh", "bash", "zsh",
  "sql", "gql", "graphql", "env", "properties",
]);

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tiff", "tif", "heic", "heif"]);

export const OFFICE_EXTENSIONS = new Set(["xlsx", "xls", "xlsm", "ods", "docx", "pptx"]);

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** 按扩展名推断 MIME（File.type 缺失时兜底，保证 data URL 前缀带正确 image/xxx） */
export function mimeFromName(name: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    tiff: "image/tiff",
    tif: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    pdf: "application/pdf",
  };
  return map[extOf(name)] || "";
}

/** 按扩展名/MIME 判断附件类型（不读内容，仅分类） */
export function classifyFile(name: string, mime = ""): PendingAttachment["kind"] {
  const ext = extOf(name);
  // SVG 是 XML 文本：走路径引用（Agent read_file 读取），避免脚本注入 + 视觉链路校验拒绝
  if (ext === "svg" || mime === "image/svg+xml") return "text";
  if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith("image/")) return "image";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) return "excel";
  if (ext === "docx") return "word";
  if (ext === "pptx") return "ppt";
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) return "text";
  return "unknown";
}

/**
 * 解析文件为可发送附件。
 * 文本/Office 仅保存路径引用，不读内容（由 core 端读取/解析）。
 * @param file 用户选择的文件
 * @param path 文件原始路径（可选，拖拽/主进程 dialog 提供）
 */
export async function parseFile(
  file: File,
  path?: string,
): Promise<PendingAttachment> {
  const kind = classifyFile(file.name, file.type);

  // 图片：读取 base64 + canvas 压缩
  if (kind === "image") {
    const dataUrl = await fileToDataUrl(file);
    let data = dataUrl;
    try {
      data = await compressImage(dataUrl);
    } catch { /* 压缩失败用原图 */ }
    return { kind: "image", name: file.name, size: file.size, data, path };
  }

  // PDF：base64 原样（走视觉桥）
  if (kind === "pdf") {
    const dataUrl = await fileToDataUrl(file);
    return { kind: "pdf", name: file.name, size: file.size, data: dataUrl, path };
  }

  // 文本 / Office：仅存路径引用，不读内容
  if (kind === "text" || kind === "excel" || kind === "word" || kind === "ppt") {
    return { kind, name: file.name, size: file.size, data: "", path };
  }

  // 其他任意文件：降级为路径引用（Agent 通过 read_file 读取），不拒绝
  return { kind: "unknown", name: file.name, size: file.size, data: "", path };
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // File.type 缺失时按扩展名补 MIME，否则 data URL 前缀无 image/... 会被校验拒绝
    const target = file.type ? file : new File([file], file.name, { type: mimeFromName(file.name) });
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ? new Error(reader.error.message) : new Error("文件读取失败"));
    reader.readAsDataURL(target);
  });
}
