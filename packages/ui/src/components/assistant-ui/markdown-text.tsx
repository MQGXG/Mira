"use client";

import { memo, useMemo } from "react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { defaultRehypePlugins } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { inlineSvgBlocks } from "../../lib/svg-inline";

/** rehype 插件条目（unified Pluggable 的结构化近似，避免直接依赖 unified 类型） */
type RehypePluginEntry = NonNullable<(typeof defaultRehypePlugins)[string]>;

/**
 * 自定义 rehype 链：raw → sanitize（放行 data: 图片）→ harden
 *
 * 为什么不用 streamdown 默认链：默认 sanitize 的 img src 协议白名单为 ["http","https"]，
 * 会把 inlineSvgBlocks 生成的 <img src="data:image/svg+xml;base64,…"> 的 src 剥掉，
 * 随后 harden 对空 src 应用 indicator 策略，替换为 "[Image blocked: SVG diagram]" 占位文本
 * —— 这是 ```svg 代码块内嵌渲染失效的根因。
 * harden 自身 allowDataImages=true、CSP img-src 也含 data:，唯一卡点是 sanitize 协议表。
 * data: 协议仅对 img 放行（img 上下文中的 SVG 不执行脚本，无 XSS 面）。
 */
function buildRehypePlugins(): RehypePluginEntry[] {
  const sanitizeEntry = defaultRehypePlugins["sanitize"];
  const sanitizePlugin = (Array.isArray(sanitizeEntry) ? sanitizeEntry[0] : sanitizeEntry) as RehypePluginEntry;
  const baseSchema: Record<string, any> =
    Array.isArray(sanitizeEntry) && sanitizeEntry[1] && typeof sanitizeEntry[1] === "object"
      ? (sanitizeEntry[1] as Record<string, any>)
      : {};
  const baseProtocols: Record<string, string[] | undefined> = baseSchema.protocols ?? {};
  const patchedSchema = {
    ...baseSchema,
    protocols: {
      ...baseProtocols,
      // 在默认白名单基础上追加 data:（保持 http/https 等原有协议不变）
      src: [...new Set([...(baseProtocols.src ?? ["http", "https"]), "data"])],
    },
  };
  return [defaultRehypePlugins["raw"], [sanitizePlugin, patchedSchema], defaultRehypePlugins["harden"]] as RehypePluginEntry[];
}

export const MarkdownText = memo(function MarkdownText() {
  const rehypePlugins = useMemo(() => buildRehypePlugins(), []);
  return (
    <StreamdownTextPrimitive
      plugins={{ code, mermaid }}
      shikiTheme={["github-light", "github-dark"]}
      preprocess={inlineSvgBlocks}
      rehypePlugins={rehypePlugins}
      defer
    />
  );
});
