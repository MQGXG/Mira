/**
 * 数据语义色板 — 统一出口
 *
 * 说明：图谱节点色、项目色板经过 WebGL（Three.js / react-force-graph-3d）
 * 渲染，CSS 变量（var(--x)）无法在其中解析，因此使用集中常量管理
 * （single source of truth），保证深浅主题下值一致、颜色稳定不变。
 */

/** 知识图谱节点类型色 */
export const GRAPH_NODE_COLORS: Record<string, string> = {
  concept: "#3b82f6",
  file: "#10b981",
  decision: "#f59e0b",
  tool: "#8b5cf6",
  project: "#06b6d4",
  memory: "#6b7280",
}

/** 动态记忆类型色 */
export const MEMORY_TYPE_COLORS: Record<string, string> = {
  semantic: "#3b82f6",
  episodic: "#f59e0b",
  procedural: "#10b981",
  declarative: "#8b5cf6",
}

/** 激活节点高亮色 */
export const GRAPH_ACTIVATION_COLOR = "#f59e0b"

/** 图谱关系边颜色（linkColor / 粒子色） */
export const GRAPH_LINK_COLORS: Record<string, string> = {
  depends_on: "rgba(239,68,68,0.4)",
  contains: "rgba(255,255,255,0.1)",
  part_of: "rgba(16,185,129,0.3)",
  based_on: "rgba(59,130,246,0.3)",
  replaces: "rgba(245,158,11,0.4)",
  co_occurs: "rgba(255,255,255,0.08)",
  similar_to: "rgba(139,92,246,0.25)",
  tagged: "rgba(255,255,255,0.12)",
  mentions: "rgba(255,255,255,0.1)",
  related_to: "rgba(6,182,212,0.2)",
  has_topic: "rgba(255,255,255,0.15)",
  has_knowledge: "rgba(255,255,255,0.1)",
}

export const GRAPH_LINK_PARTICLE_COLORS: Record<string, string> = {
  depends_on: "rgba(239,68,68,0.6)",
  contains: "rgba(255,255,255,0.3)",
  based_on: "rgba(59,130,246,0.5)",
  co_occurs: "rgba(255,255,255,0.2)",
  similar_to: "rgba(139,92,246,0.4)",
}

/** 项目颜色板（12 色） */
export const PROJECT_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#06b6d4", "#3b82f6", "#64748b", "#78716c",
]

/** 默认项目色 */
export const DEFAULT_PROJECT_COLOR = "#3b3b3b"
