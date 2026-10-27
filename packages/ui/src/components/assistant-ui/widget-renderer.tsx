"use client";

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, MoreHorizontal, MessageSquarePlus, Code2, Image as ImageIcon } from "lucide-react";
import {
  prepareWidgetHtml,
  widgetFileName,
  svgFileName,
  wrapStandaloneHtml,
  copyTextToClipboard,
  copyPngToClipboard,
  svgToPngDataUrl,
  toSvgDataUrl,
  normalizeSvgSize,
  type WidgetLang,
} from "./widget-utils";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { DialogService } from "../../services/dialog.service";
import { ThemeContext } from "../../contexts/ThemeContext";

// 本地库源码（?raw 导入 → iframe 内联注入，离线可用、符合 CSP）
// Chart.js 是 UMD 格式，可内联 <script>；mermaid 是 ESM，改由 UI 端 mermaid 插件渲染（```mermaid 块）
// 用相对路径绕过 chart.js package exports 限制（Vite ?raw 走文件系统）
import chartJsSrc from "../../../../../node_modules/chart.js/dist/chart.umd.min.js?raw";
// 修改点：html2canvas 内联注入（隐藏 iframe 离线截图用，"复制/保存为图片"）
import html2canvasSrc from "../../../../../node_modules/html2canvas/dist/html2canvas.min.js?raw";

/** 需要注入到 iframe 的本地库（脚本片段，按名字注册为全局变量） */
const INJECTABLE_LIBS: Record<string, string> = {
  "chart.js": chartJsSrc,
  chart: chartJsSrc,
  chart_umd: chartJsSrc,
  "chart.umd": chartJsSrc,
};

/** 主题注入色（无 Provider 环境的兜底值） */
const FALLBACK_THEME = {
  light: { bg: "#ffffff", fg: "#1f2328" },
  dark: { bg: "#16181d", fg: "#e6e6e6" },
};

/**
 * Widget 工具函数仅供内部 captured iframe 使用 — 构建 iframe 文档（含主题注入与高度上报）
 */
function buildWidgetDoc(preparedHtml: string, theme: { bg: string; fg: string; dark: boolean }, extraScript = ""): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 12px; background: ${theme.bg}; color: ${theme.fg}; color-scheme: ${theme.dark ? "dark" : "light"}; }
</style>
</head>
<body>
${preparedHtml}
<script>
  function reportHeight() {
    var h = document.body.scrollHeight;
    window.parent.postMessage({ type: 'mira-widget-height', height: h }, '*');
  }
  window.addEventListener('load', function() { setTimeout(reportHeight, 100); });
  // 监听 DOM 变化（chart.js/异步渲染完成后触发）
  var mo = new MutationObserver(function() { setTimeout(reportHeight, 50); });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener('message', function(e) {
    if (e.data === 'mira-widget-request-height') reportHeight();
    if (e.data === 'mira-widget-request-capture' && typeof window.__miraShoot === 'function') window.__miraShoot();
  });
${extraScript}
</script>
</body>
</html>`;
}

/**
 * 修改点：隐藏 iframe 内 html2canvas 截图 HTML → PNG data URL
 * （sandbox 无 same-origin，无法向 iframe 文档注入脚本；
 *  直接在截图文档源码中内联 html2canvas，postMessage 三步交互：
 *  报高度 → 父窗口调整 iframe 高度 → 发 capture 请求 → 回传 dataURL）
 */
async function captureHtmlPng(html: string, theme: { bg: string; fg: string; dark: boolean }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const prepared = prepareWidgetHtml(html, INJECTABLE_LIBS).processed;
    const width = 720;
    // 纯 JS 片段（buildWidgetDoc 的 <script> 内部追加，不能再嵌套 <script> 标签）
    const captureScript = `
    window.__miraShoot = function() {
      html2canvas(document.body, {
        backgroundColor: '${theme.bg}',
        scale: 2,
        logging: false,
        windowWidth: ${width},
        windowHeight: document.body.scrollHeight
      }).then(function(canvas) {
        window.parent.postMessage({ type: 'mira-widget-shot', png: canvas.toDataURL('image/png') }, '*');
      }).catch(function(err) {
        window.parent.postMessage({ type: 'mira-widget-shot', error: String(err && err.message || err) }, '*');
      });
    };`;
    // html2canvas 单独以 <script> 标签内联进 body 末尾（源码 ~200KB，仅截图请求时存在一次）
    const captureLibTag = `<script type="text/javascript">${html2canvasSrc}</${"script"}>`;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = `position:fixed; right:-10000px; bottom:0; width:${width}px; height:300px; border:0;`;
    // 截图库以 <script> 标签插入 body 末尾；__miraShoot 挂在主脚本内（经 extraScript 注入）
    iframe.srcdoc = buildWidgetDoc(prepared, theme, captureScript).replace("</body>", `${captureLibTag}</body>`);

    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      // 显式类型收窄（事件 data 为 any）
      const d = e.data as { type?: string; height?: number; png?: string; error?: string } | null;
      if (d?.type === "mira-widget-height" && typeof d.height === "number") {
        iframe.style.height = `${Math.min(Math.max(d.height, 200), 3000)}px`;
        setTimeout(() => iframe.contentWindow?.postMessage("mira-widget-request-capture", "*"), 100);
      } else if (d?.type === "mira-widget-shot") {
        cleanup();
        if (d.png) resolve(d.png);
        else reject(new Error(d.error || "截图失败"));
      }
    };

    const cleanup = () => {
      window.removeEventListener("message", onMsg);
      iframe.remove();
    };

    window.addEventListener("message", onMsg);
    document.body.appendChild(iframe);
    setTimeout(() => {
      cleanup();
      reject(new Error("截图超时"));
    }, 20000);
  });
}

/**
 * 可视化渲染卡片 — 单容器双视图（预览 ↔ 代码原位切换）
 * 承载 LLM 生成的富 HTML（iframe 沙箱）/ SVG（data URL img），本地注入图表库。
 * - html：sandbox="allow-scripts" + 高度上报 + 主题底色注入 + 本地 chart.js
 * - svg：data URL `<img>`（脚本不执行，更轻、更安全）
 * - 右上角悬浮工具栏：添加到对话 / 下载到本地 / ⋯（复制为图片、保存为图片、复制代码、切换视图）
 */
function WidgetRendererImpl({
  html,
  lang,
  className = "",
  onAddToChat,
}: {
  html: string;
  /** 代码块语言（html/svg；历史消息缺省按 html 处理） */
  lang?: WidgetLang;
  className?: string;
  /** 修改点：「添加到对话」回调（由 ChatWindow 提供实现，widget-test 无 runtime 时不显示该按钮） */
  onAddToChat?: (code: string, lang: WidgetLang) => void;
}) {
  const kind: WidgetLang = lang === "svg" ? "svg" : "html";
  const [view, setView] = useState<"preview" | "code">("preview");
  const [height, setHeight] = useState(360);
  const [svgPreviewH, setSvgPreviewH] = useState(0);
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 主题底色（跟随 Mira 深浅主题；无 Provider 环境容错）
  const themeCtx = useContext(ThemeContext);
  const theme = useMemo(() => {
    const fb = themeCtx?.resolvedTheme === "light" ? FALLBACK_THEME.light : FALLBACK_THEME.dark;
    try {
      const cs = getComputedStyle(document.body);
      return {
        bg: cs.backgroundColor || fb.bg,
        fg: cs.color || fb.fg,
        dark: themeCtx?.resolvedTheme !== "light",
      };
    } catch {
      return { ...fb, dark: themeCtx?.resolvedTheme !== "light" };
    }
  }, [themeCtx?.resolvedTheme]);

  // 预处理 HTML（CDN → 本地注入）
  const preparedHtml = useMemo(() => prepareWidgetHtml(html, INJECTABLE_LIBS).processed, [html]);

  // 构造 iframe srcDoc
  const srcDoc = useMemo(() => buildWidgetDoc(preparedHtml, theme), [preparedHtml, theme]);

  // svg 预览 data URL
  const svgUrl = useMemo(() => (kind === "svg" ? toSvgDataUrl(normalizeSvgSize(html)) : ""), [html, kind]);

  // 监听 preview iframe 高度消息（只认本实例 iframe 的消息，防多卡片串扰）
  useEffect(() => {
    if (kind !== "html") return;
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      // 显式类型收窄（事件 data 为 any）
      const d = e.data as { type?: string; height?: number } | null;
      if (d?.type === "mira-widget-height" && typeof d.height === "number") {
        const h = Math.min(Math.max(d.height, 100), 1200);
        setHeight(h);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [kind]);

  // 高度变化时主动请求（配合 MutationObserver 的初始触发）
  useEffect(() => {
    if (kind !== "html") return;
    const t = setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage("mira-widget-request-height", "*");
    }, 200);
    return () => clearTimeout(t);
  }, [preparedHtml, kind]);

  // 卸载时清理计时器
  useEffect(() => {
    return () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  /** 临时提示（工具栏反馈） */
  const flashNote = useCallback((msg: string) => {
    setNote(msg);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 1600);
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(html);
    flashNote(ok ? "已复制代码" : "复制失败");
  }, [html, flashNote]);

  const handleDownload = useCallback(async () => {
    const name = kind === "svg" ? svgFileName(html) : widgetFileName(html);
    const content = kind === "svg" ? html : wrapStandaloneHtml(html);
    const ok = await DialogService.saveTextFile(name, content).catch(() => false);
    flashNote(ok ? "已下载" : "下载失败");
  }, [html, kind, flashNote]);

  const handleCopyImage = useCallback(async () => {
    try {
      const dataUrl = kind === "svg" ? await svgToPngDataUrl(html, 2) : await captureHtmlPng(html, theme);
      const ok = await copyPngToClipboard(dataUrl);
      flashNote(ok ? "已复制图片" : "复制图片失败");
    } catch {
      flashNote("复制图片失败");
    }
  }, [html, kind, theme, flashNote]);

  const handleSaveImage = useCallback(async () => {
    try {
      const dataUrl = kind === "svg" ? await svgToPngDataUrl(html, 2) : await captureHtmlPng(html, theme);
      const base = kind === "svg" ? svgFileName(html) : widgetFileName(html);
      const pngName = `${base.replace(/\.[a-z0-9]+$/i, "")}.png`;
      const b64 = dataUrl.split(",")[1] || "";
      const ok = await DialogService.saveBinaryFileBase64(pngName, b64).catch(() => false);
      flashNote(ok ? "已保存图片" : "保存失败");
    } catch {
      flashNote("保存图片失败");
    }
  }, [html, kind, theme, flashNote]);

  const handleAddToChat = useCallback(() => {
    onAddToChat?.(html, kind);
    flashNote("已添加到输入框");
  }, [html, kind, onAddToChat, flashNote]);

  // 代码视图高度：html 沿用预览高度；svg 取预览测量高度（下限 160，上限 480）
  const codeHeight = kind === "html" ? height : Math.min(Math.max(svgPreviewH, 160), 480);

  return (
    <div className={`mira-widget group relative overflow-hidden rounded-xl border border-[var(--border)] ${className}`}>
      {/* ── 双视图内容（原位切换，不再上下堆叠） ── */}
      {view === "preview" ? (
        kind === "svg" ? (
          /* svg：data URL img（不执行脚本） */
          <div style={{ background: theme.bg, padding: 12 }}>
            <img
              src={svgUrl}
              alt="SVG 可视化"
              style={{ display: "block", width: "100%", height: "auto" }}
              onLoad={(e) => setSvgPreviewH(e.currentTarget.getBoundingClientRect().height)}
              onError={() => setSvgPreviewH(240)}
            />
          </div>
        ) : (
          /* html：iframe 沙箱 + 高度自适应 + 主题底色 */
          <div style={{ height, transition: "height 0.15s ease", background: theme.bg }}>
            <iframe
              ref={iframeRef}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              title="可视化组件"
              style={{ width: "100%", height: "100%", border: "none", background: "transparent" }}
            />
          </div>
        )
      ) : (
        <pre
          className="scrollbar-custom overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap break-all"
          style={{
            margin: 0,
            padding: 12,
            height: codeHeight,
            background: theme.dark ? "#0f1115" : "#24292f",
            color: "#e6e6e6",
            transition: "height 0.15s ease",
          }}
        >{html}</pre>
      )}

      {/* ── 右上角悬浮工具栏（hover 显示；菜单打开或操作反馈期间保持可见） ── */}
      <div
        className={`absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg p-0.5 transition-opacity duration-150 ${
          menuOpen || note ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        style={{ background: "rgba(15,17,21,0.55)", backdropFilter: "blur(6px)" }}
      >
        {note && (
          <span className="px-1 text-[10px] text-white/80 select-none">{note}</span>
        )}
        {onAddToChat && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddToChat}
            className="h-6 gap-1 text-[11px] px-2 text-white/90 hover:bg-white/10 hover:text-white"
            title="把该组件代码添加到输入框继续对话"
          >
            <MessageSquarePlus className="w-3 h-3" />
            添加到对话
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          className="h-6 gap-1 text-[11px] px-2 text-white/90 hover:bg-white/10 hover:text-white"
          title="下载到本地"
        >
          <Download className="w-3 h-3" />
          下载到本地
        </Button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-white/90 hover:bg-white/10 hover:text-white"
              title="更多操作"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs min-w-[132px]">
            <DropdownMenuItem onClick={handleCopyImage}>
              <Copy className="w-3 h-3" />
              复制为图片
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleSaveImage}>
              <ImageIcon className="w-3 h-3" />
              保存为图片
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopy}>
              <Copy className="w-3 h-3" />
              复制代码
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setView(view === "preview" ? "code" : "preview")}>
              <Code2 className="w-3 h-3" />
              {view === "preview" ? "查看代码" : "查看预览"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </div>
  );
}

export const WidgetRenderer = memo(WidgetRendererImpl);
export { prepareWidgetHtml, extractWidgetBlocks } from "./widget-utils";
