/**
 * Widget 工具函数 — 从消息文本中提取/处理可视化代码块
 * 独立文件以便测试（widget-renderer 含 chart.js 导入，不便单测）
 */

/**
 * 从 assistant 文本中提取所有 widget 代码块（```html ... ```）
 * 返回 [剩余文本, widget HTML 数组]
 */
export function extractWidgetBlocks(text: string): { cleanText: string; widgets: string[] } {
  if (!text) return { cleanText: text || "", widgets: [] };

  const widgets: string[] = [];
  const pattern = /```(?:html|widget)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const cleanParts: string[] = [];
  let lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    cleanParts.push(text.slice(lastIndex, match.index));
    widgets.push(match[1].trim());
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
