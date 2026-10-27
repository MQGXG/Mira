/**
 * Widget 工具函数 — 从消息文本中提取/处理可视化代码块
 * 独立文件以便测试（widget-renderer 含 chart.js 导入，不便单测）
 */

/** widget 语言类型（html / svg，历史消息无 lang 时按 html 处理） */
export type WidgetLang = "html" | "svg";

export interface WidgetBlock {
  html: string;
  lang: WidgetLang;
}

/**
 * 从 assistant 文本中提取所有 widget 代码块（```html/```widget/```svg ... ```)
 * 返回 [剩余文本, widget 数组（含语言标记）]
 * 修改点：新增 ```svg 支持，markers 返回结构化为 { html, lang }
 */
export function extractWidgetBlocks(text: string): { cleanText: string; widgets: WidgetBlock[] } {
  if (!text) return { cleanText: text || "", widgets: [] };

  const widgets: WidgetBlock[] = [];
  const pattern = /```(html|widget|svg)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  const cleanParts: string[] = [];
  let lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    const lang = match[1].toLowerCase();
    const body = match[2].trim();
    // svg 必须内容完整（含 </svg> 闭合）才提取，未闭合保留原文（流式安全）
    if (lang === "svg" && !/<\/svg\s*>/i.test(body)) continue;
    cleanParts.push(text.slice(lastIndex, match.index));
    widgets.push({ html: body, lang: lang === "svg" ? "svg" : "html" });
    lastIndex = match.index + match[0].length;
  }
  cleanParts.push(text.slice(lastIndex));

  const cleanText = cleanParts.join("").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, widgets };
}

/** CDN 库 URL 的识别关键词 → 本地库名 */
const CDN_LIB_MAP: Record<string, string> = {
  "chart.js": "chart.js",
  "chart.umd": "chart.js",
  "chartjs": "chart.js",
  "cdnjs.cloudflare.com/ajax/libs/Chart.js": "chart.js",
};

/** 需要注入到 iframe 的本地库（由 widget-renderer 提供源码注入） */
export interface InjectableLib {
  key: string
  src: string
}

/**
 * 预处理 widget HTML：
 * 1. 移除外部 CDN script 引用（识别 chart.js/mermaid 等）
 * 2. 标记需要本地注入的库
 * 3. 清理其他不安全的外部 script
 */
export function prepareWidgetHtml(html: string, injectableLibs: Record<string, string>): { processed: string; neededLibs: string[] } {
  if (!html) return { processed: "<div>空内容</div>", neededLibs: [] };

  const neededLibs = new Set<string>();
  const srcPattern = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  const cleanedHtml = html.replace(srcPattern, (match, url: string) => {
    const lower = url.toLowerCase();
    // 识别需要本地注入的库
    for (const [key, libKey] of Object.entries(CDN_LIB_MAP)) {
      if (lower.includes(key.toLowerCase())) {
        if (injectableLibs[libKey]) neededLibs.add(libKey);
        return ""; // 移除 CDN 引用，由下方注入
      }
    }
    // 其他外部 script 移除（CSP 阻止 + 安全）
    return "";
  });

  // 前置注入库源码
  let injection = "";
  for (const libKey of neededLibs) {
    const src = injectableLibs[libKey];
    if (src) {
      injection += `<script>${src}</script>\n`;
    }
  }

  return { processed: `${injection}\n${cleanedHtml}`, neededLibs: Array.from(neededLibs) };
}

/**
 * 从 widget HTML 中提取 <title> 生成文件名（非法字符替换、长度限制）
 */
export function widgetFileName(html: string, fallback = "widget.html"): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let name = m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  if (!name) return fallback;
  name = name.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 60);
  return name ? `${name}.html` : fallback;
}

/**
 * 修改点：SVG 内容按语言生成下载文件名（<title> 或 fallback）
 */
export function svgFileName(svg: string, fallback = "widget.svg"): string {
  const m = svg.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let name = m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  if (!name) return fallback;
  name = name.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 60);
  return name ? `${name}.svg` : fallback;
}

/**
 * 修改点：SVG 源码 → base64 data URL（供 <img> 预览，脚本不执行）
 */
export function toSvgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * 修改点：补齐 SVG 根元素缺失的 width/height（仅 viewBox 时 img 可能退化默认尺寸）
 * 正则实现，无 DOM 依赖（node 单测环境可运行）；未匹配时返回原文
 */
export function normalizeSvgSize(svg: string): string {
  const root = svg.match(/<svg\b[^>]*>/i);
  if (!root) return svg;
  const tag = root[0];
  if (/\swidth\s*=\s*["']\d/i.test(tag) && /\sheight\s*=\s*["']\d/i.test(tag)) return svg;
  const vb = tag.match(/viewBox\s*=\s*["']([\d.\s,\-eE]+)["']/i);
  if (!vb) return svg;
  const dims = vb[1].trim().split(/[\s,]+/).map(Number);
  if (dims.length !== 4 || dims.some((n) => !Number.isFinite(n))) return svg;
  let out = tag;
  if (!/\swidth\s*=\s*["']/i.test(out)) out = out.replace(/<svg\b/i, `<svg width="${dims[2]}"`);
  if (!/\sheight\s*=\s*["']/i.test(out)) out = out.replace(/<svg\b/i, `<svg height="${dims[3]}"`);
  return svg.replace(tag, out);
}

/**
 * 修改点：SVG → PNG data URL（canvas 2x 导出，供复制/保存为图片）
 */
export async function svgToPngDataUrl(svg: string, scale = 2): Promise<string> {
  const normalized = normalizeSvgSize(svg);
  const url = toSvgDataUrl(normalized);
  const img = new Image();
  img.src = url;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG 加载失败"));
  });
  const w = img.naturalWidth || 800;
  const h = img.naturalHeight || 600;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 不可用");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * 修改点：PNG data URL 复制到系统剪贴板（ClipboardItem，Electron renderer 支持）
 */
export async function copyPngToClipboard(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将片段 HTML 包装为可独立打开的完整文档。
 * 保留原始 CDN 引用，下载后在浏览器可直接打开渲染。
 */
export function wrapStandaloneHtml(html: string): string {
  if (!html) return html;
  if (/<html[\s>]/i.test(html)) return html;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mira 可视化组件</title>
</head>
<body>
${html}
</body>
</html>`;
}

/**
 * 将字符串复制到剪贴板（优先异步 Clipboard API，降级 execCommand）。
 * @returns 是否复制成功
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走降级方案
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
