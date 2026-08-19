import type { AttachmentAdapter } from "@assistant-ui/react";

/**
 * 增强的文件附件适配器
 * - 图片：以 base64 data URL 形式嵌入消息
 * - 文本文件：读取内容原样传递
 * - 其他文件：将文件路径转为可读提示
 */
export const fileAttachmentAdapter: AttachmentAdapter = {
  accept: "*/*",

  async add({ file }) {
    const isImage = file.type.startsWith("image/");
    const isText = file.type.startsWith("text/") ||
      ["json", "xml", "yaml", "yml", "toml", "csv", "md", "ts", "tsx", "js", "jsx", "py", "rs", "go", "css", "scss", "html", "sh", "bash", "log"]
        .some(ext => file.name.endsWith("." + ext));

    let text = "";
    let dataUrl = "";

    if (isImage) {
      dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
    } else if (isText) {
      text = await file.slice(0, 100_000).text();
    } else {
      text = `[文件: ${file.name} (${(file.size / 1024).toFixed(1)} KB)]`;
    }

    return {
      id: crypto.randomUUID(),
      type: isImage ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
      text,
      url: dataUrl || undefined,
    };
  },

  async send(attachment) {
    const isImage = attachment.type === "image";
    const contentText = (attachment as any).text || "";
    const attachmentUrl = (attachment as any).url as string | undefined;
    await Promise.resolve();

    return {
      ...attachment,
      status: { type: "complete" },
      content: isImage
        ? [{ type: "image" as const, image: attachmentUrl || "" }]
        : [{ type: "text" as const, text: contentText }],
    };
  },

  async remove() {},
};

/**
 * 拖拽文件适配器 — 将拖入的文件路径转为消息文本
 */
export function formatDroppedFiles(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) return `读取文件: ${paths[0]}`;
  return `读取文件:\n${paths.map(p => `  - ${p}`).join("\n")}`;
}
