/**
 * 3D 知识图谱 — 基于 react-force-graph-3d 的交互式可视化
 * 支持传统知识图谱和动态记忆图谱（神经网络激活可视化）
 */

import { useRef, useCallback, useMemo, useState, useEffect } from "react"
import type { GraphData, GraphNode, GraphLink } from "./graph-data"
import { buildGraphFromKnowledgeStore, buildGraphFromMemories } from "./graph-data"
import { Button } from "../components/ui/button"
import { GRAPH_NODE_COLORS, MEMORY_TYPE_COLORS, GRAPH_ACTIVATION_COLOR, GRAPH_LINK_COLORS, GRAPH_LINK_PARTICLE_COLORS } from "../theme/data-colors"
import type { MemoryNode, ActivationResult } from "@mira/core"

// 动态导入 react-force-graph-3d（避免 SSR 问题）
let ForceGraph3D: any = null

const ALL_RELATION_TYPES = [
  "depends_on", "depended_by",
  "contains", "contained_by",
  "part_of", "has_part",
  "based_on", "basis_for",
  "replaces", "replaced_by",
  "co_occurs", "similar_to",
  "tagged", "mentions", "related_to",
  "has_topic", "has_knowledge",
]

const RELATION_LABELS: Record<string, string> = {
  depends_on: "依赖", depended_by: "被依赖",
  contains: "包含", contained_by: "被包含",
  part_of: "属于", has_part: "拥有",
  based_on: "基于", basis_for: "作为基础",
  replaces: "替代", replaced_by: "被替代",
  co_occurs: "共现", similar_to: "相似",
  tagged: "标记", mentions: "提及", related_to: "相关",
  has_topic: "主题", has_knowledge: "知识",
}

/** 记忆类型中文名 */
const MEMORY_TYPE_LABELS: Record<string, string> = {
  semantic: "语义记忆",
  episodic: "情景记忆",
  procedural: "程序性记忆",
  declarative: "陈述性记忆",
}

/** 从动态记忆节点构建图谱数据 */
function buildGraphFromDynamicNodes(nodes: Map<string, MemoryNode>): GraphData {
  const graphNodes: GraphNode[] = []
  const graphLinks: GraphLink[] = []

  // 添加节点
  for (const [id, node] of nodes) {
    graphNodes.push({
      id,
      label: id,
      type: "concept",
      size: 8 + node.importance * 12,
      color: MEMORY_TYPE_COLORS[node.type] || GRAPH_NODE_COLORS.concept,
      description: node.content.slice(0, 200),
    })

    // 添加边
    for (const [neighborId, strength] of node.associationStrengths) {
      if (nodes.has(neighborId)) {
        graphLinks.push({
          source: id,
          target: neighborId,
          relation: "related_to",
          strength,
        })
      }
    }
  }

  return { nodes: graphNodes, links: graphLinks }
}

interface MemoryGraphProps {
  memories?: Array<{ content: string; tags?: string[]; source?: string }>
  knowledgeEntries?: Array<{ content: string; tags: string[] }>
  graphData?: GraphData
  projectName?: string
  onNodeClick?: (node: GraphNode) => void
  height?: number
  hiddenRelations?: Set<string>
  onToggleRelation?: (relation: string) => void
  /** 动态记忆图谱节点（来自 DynamicMemoryManager） */
  dynamicNodes?: Map<string, MemoryNode>
  /** 激活结果（用于高亮显示激活路径） */
  activationResult?: ActivationResult | null
  /** 激活路径高亮颜色 */
  activationColor?: string
}

export function MemoryGraph({
  memories = [],
  knowledgeEntries = [],
  graphData: externalGraphData,
  projectName,
  onNodeClick,
  height = 500,
  hiddenRelations = new Set(),
  onToggleRelation,
  dynamicNodes,
  activationResult,
  activationColor = GRAPH_ACTIVATION_COLOR,
}: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height })
  const [loaded, setLoaded] = useState(false)
  const [filterOpen, setFilterOpen] = useState(true)

  // 构建图谱数据
  const rawData = useMemo(() => {
    // 优先使用外部图谱数据
    if (externalGraphData) return externalGraphData

    // 使用动态记忆图谱数据
    if (dynamicNodes && dynamicNodes.size > 0) {
      return buildGraphFromDynamicNodes(dynamicNodes)
    }

    // 使用传统知识图谱
    return knowledgeEntries.length > 0
      ? buildGraphFromKnowledgeStore(knowledgeEntries)
      : buildGraphFromMemories(memories)
  }, [memories, knowledgeEntries, externalGraphData, dynamicNodes])

  // 构建激活节点集合（用于高亮）
  const activatedNodeIds = useMemo(() => {
    if (!activationResult) return new Set<string>()
    return new Set(activationResult.nodes.map(n => n.id))
  }, [activationResult])

  // 构建激活路径集合（用于高亮边）
  const activatedPathEdges = useMemo(() => {
    if (!activationResult) return new Set<string>()
    const edges = new Set<string>()
    for (const path of activationResult.paths) {
      edges.add(`${path.from}->${path.to}`)
    }
    return edges
  }, [activationResult])

  // 过滤关系，确保至少有根节点
  const graphData = useMemo(() => {
    const filteredLinks = rawData.links.filter(l => !hiddenRelations.has(l.relation))
    // 如果没有节点，至少显示根节点
    if (rawData.nodes.length === 0) {
      return {
        nodes: [{ id: "root", label: projectName || "知识库", type: "project" as const, size: 20, color: GRAPH_NODE_COLORS.project, description: "暂无记忆数据" }],
        links: [],
      }
    }
    return { nodes: rawData.nodes, links: filteredLinks }
  }, [rawData, hiddenRelations, projectName])

  // 监听容器尺寸变化
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 动态加载 ForceGraph3D
  useEffect(() => {
    import("react-force-graph-3d").then((mod) => {
      ForceGraph3D = mod.default
      setLoaded(true)
    })
  }, [])

  const handleNodeClick = useCallback((node: GraphNode) => {
    const graphNode: GraphNode = {
      id: node.id,
      label: node.label,
      type: node.type,
      size: node.size,
      color: node.color,
      description: node.description,
    }
    setSelectedNode(graphNode)
    onNodeClick?.(graphNode)
  }, [onNodeClick])

  const graphConfig = useMemo(() => ({
    graphData,
    width: dimensions.width,
    height: dimensions.height,
    backgroundColor: "rgba(0,0,0,0)",
    nodeLabel: (node: GraphNode) => {
      const isActivated = activatedNodeIds.has(node.id)
      const activationBadge = isActivated ? `<span style="background:${GRAPH_ACTIVATION_COLOR};color:#000;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px">激活</span>` : ''
      return `<div style="background:rgba(15,15,15,0.95);padding:8px 12px;border-radius:8px;border:1px solid ${isActivated ? 'rgba(245,158,11,0.5)' : 'rgba(255,255,255,0.15)'};font-size:13px;max-width:280px"><b style="color:${node.color};font-size:14px">${node.label}</b>${activationBadge}<br/><span style="color:#9ca3af;font-size:11px">${node.type === "project" ? "项目" : node.type}</span>${node.description ? `<br/><span style="color:#6b7280;max-width:240px;display:block;margin-top:4px;font-size:11px;line-height:1.4">${node.description.slice(0, 150)}</span>` : ""}</div>`
    },
    nodeColor: (node: GraphNode) => {
      // 激活节点使用特殊颜色
      if (activatedNodeIds.has(node.id)) return activationColor
      return node.color
    },
    nodeVal: (node: GraphNode) => {
      const baseSize = node.id === "root" ? 20 : node.size
      // 激活节点放大 1.5 倍
      return activatedNodeIds.has(node.id) ? baseSize * 1.5 : baseSize
    },
    nodeOpacity: 1,
    nodeRelSize: 4,
    linkColor: (link: GraphLink) => {
      // 激活路径使用特殊颜色
      const edgeKey = `${link.source}->${link.target}`
      if (activatedPathEdges.has(edgeKey)) return activationColor
      if (activatedPathEdges.has(`${link.target}->${link.source}`)) return activationColor

      return GRAPH_LINK_COLORS[link.relation] || "rgba(255,255,255,0.1)"
    },
    linkWidth: (link: GraphLink) => {
      // 激活路径加粗
      const edgeKey = `${link.source}->${link.target}`
      const isActivated = activatedPathEdges.has(edgeKey) || activatedPathEdges.has(`${link.target}->${link.source}`)
      return isActivated ? 2.5 : link.strength > 0.4 ? 1.2 : 0.5
    },
    linkDirectionalParticles: (link: GraphLink) => {
      const edgeKey = `${link.source}->${link.target}`
      const isActivated = activatedPathEdges.has(edgeKey) || activatedPathEdges.has(`${link.target}->${link.source}`)
      return isActivated ? 4 : link.strength > 0.3 ? 2 : 1
    },
    linkDirectionalParticleWidth: 1,
    linkDirectionalParticleColor: (link: GraphLink) => {
      const edgeKey = `${link.source}->${link.target}`
      if (activatedPathEdges.has(edgeKey) || activatedPathEdges.has(`${link.target}->${link.source}`)) return activationColor

      return GRAPH_LINK_PARTICLE_COLORS[link.relation] || "rgba(255,255,255,0.3)"
    },
    linkLabel: (link: GraphLink) => `<div style="background:rgba(20,20,20,0.9);padding:3px 8px;border-radius:4px;font-size:11px;border:1px solid rgba(255,255,255,0.1)">${link.relation.replace(/_/g, " ")}</div>`,
    onNodeClick: handleNodeClick,
    onNodeHover: (node: GraphNode | null) => { if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "default" },
    d3VelocityDecay: 0.3,
    warmupTicks: 100,
    cooldownTicks: 150,
  }), [graphData, dimensions, handleNodeClick, activatedNodeIds, activatedPathEdges, activationColor])

  if (!loaded) {
    return (
      <div ref={containerRef} className="relative bg-background" style={{ height }}>
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          加载图谱中...
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative bg-background" style={{ height }}>
      {ForceGraph3D && <ForceGraph3D {...graphConfig} />}

      {/* 节点详情浮窗 */}
      {selectedNode && (
        <div className="absolute top-3 right-3 p-3 rounded-lg text-xs max-w-[240px] bg-elevated border border-standard shadow-floating z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-fg">{selectedNode.label}</span>
            <Button variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground" onClick={() => setSelectedNode(null)}>✕</Button>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full" style={{ background: selectedNode.color }} />
            <span className="text-secondary">{selectedNode.type}</span>
          </div>
          {selectedNode.description && (
            <p className="mt-2 leading-relaxed text-tertiary">{selectedNode.description}</p>
          )}
        </div>
      )}

      {/* 图例 */}
      <div className="absolute bottom-3 left-3 p-2 rounded-lg text-[10px] flex flex-col gap-1 bg-elevated border border-standard shadow-floating">
        <div className="font-medium mb-1 text-secondary">节点类型</div>
        {dynamicNodes && dynamicNodes.size > 0 ? (
          // 动态记忆图谱图例
          Object.entries(MEMORY_TYPE_LABELS).map(([type, label]) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: MEMORY_TYPE_COLORS[type] }} />
              <span className="text-tertiary">{label}</span>
            </div>
          ))
        ) : (
          // 传统知识图谱图例
          (["project", "concept", "file", "decision"] as const).map((type) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: GRAPH_NODE_COLORS[type] }} />
              <span className="text-tertiary">{{ project: "项目", concept: "概念", file: "文件", decision: "决策" }[type]}</span>
            </div>
          ))
        )}
        {activationResult && activationResult.nodes.length > 0 && (
          <div className="mt-1 pt-1 border-t border-standard">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: activationColor }} />
              <span className="text-tertiary">激活节点</span>
            </div>
            <div className="mt-0.5 text-quaternary text-[9px]">
              激活强度: {activationResult.activationStrength.toFixed(2)}
            </div>
          </div>
        )}
      </div>

      {/* 节点统计 */}
      <div className="absolute top-3 left-3 px-2 py-1 rounded text-[10px] bg-elevated border border-standard text-tertiary">
        {graphData.nodes.length} 节点 · {graphData.links.length} 关系
      </div>

      {/* 关系过滤器 */}
      {onToggleRelation && (
        <div className="absolute top-3 right-3 rounded-lg text-[10px] bg-elevated border border-standard shadow-floating" style={{ width: filterOpen ? 160 : "auto" }}>
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className="flex items-center gap-1.5 px-2 py-1.5 w-full font-medium text-secondary"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d={filterOpen ? "M2 3l3 3 3-3" : "M3 2l3 3-3 3"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            关系过滤
            <span className="ml-auto text-[9px] text-quaternary">{hiddenRelations.size} 隐藏</span>
          </button>
          {filterOpen && (
            <div className="px-2 pb-2 max-h-[250px] overflow-y-auto scrollbar-custom">
              {ALL_RELATION_TYPES.map(rel => (
                <label key={rel} className="flex items-center gap-1.5 py-0.5 cursor-pointer text-tertiary">
                  <input type="checkbox" checked={!hiddenRelations.has(rel)} onChange={() => onToggleRelation(rel)} className="w-3 h-3" />
                  <span>{RELATION_LABELS[rel] || rel}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
