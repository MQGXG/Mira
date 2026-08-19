/**
 * 图谱面板 — 可嵌入侧边栏或独立对话框
 */

import { useState, useEffect } from "react"
import { Network } from "lucide-react"
import { Modal } from "../components/ui/Modal"
import { MemoryGraph } from "./MemoryGraph"
import type { GraphNode, GraphLink, GraphData } from "./graph-data"
import { buildGraphFromKnowledgeStore } from "./graph-data"
import { MemoryService, type GraphDataFromDream } from "../services/memory.service"
import { ProjectService } from "../services/project.service"
import { GRAPH_NODE_COLORS } from "../theme/data-colors"

interface GraphPanelProps {
  open: boolean
  onClose: () => void
  projectId?: string
  projectName?: string
}

export function GraphPanel({ open, onClose, projectId, projectName }: GraphPanelProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] })
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [hiddenRelations, setHiddenRelations] = useState<Set<string>>(new Set(["co_occurs"]))
  const [globalView, setGlobalView] = useState(false)
  // 图谱高度：动态适配窗口高度（min 400，留出顶部/底部工具栏空间）
  const [graphHeight, setGraphHeight] = useState(600)

  useEffect(() => {
    const calc = () => setGraphHeight(Math.max(400, window.innerHeight - 180))
    calc()
    window.addEventListener("resize", calc)
    return () => window.removeEventListener("resize", calc)
  }, [])

  const toggleRelation = (relation: string) => {
    setHiddenRelations(prev => {
      const next = new Set(prev)
      if (next.has(relation)) next.delete(relation)
      else next.add(relation)
      return next
    })
  }

  useEffect(() => {
    if (!open) return
    setLoading(true)

    const loadData = async () => {
      try {
        if (globalView || !projectId) {
          // ── 全局模式：多项目根节点 + 跨项目共享节点 ──
          const projects = await ProjectService.list()
          if (projects.length === 0) {
            setGraphData({ nodes: [{ id: "root", label: "暂无项目", type: "project", size: 20, color: GRAPH_NODE_COLORS.project }], links: [] })
            return
          }

          const allNodes: GraphNode[] = []
          const allLinks: GraphLink[] = []
          const globalEntityMap = new Map<string, GraphNode>() // 跨项目共享实体

          for (const proj of projects) {
            const results = await MemoryService.searchByProject("", proj.project_id, 50)
            const memories = results.map((r) => ({ content: r.content || "", tags: [] as string[] }))

            // 为每个项目创建根节点
            const projectRoot: GraphNode = {
              id: `proj-${proj.project_id}`,
              label: proj.name,
              type: "project",
              size: 24,
              color: GRAPH_NODE_COLORS.project,
              description: `${memories.length} 条记忆`,
            }
            allNodes.push(projectRoot)

            // 提取该项目的实体
            const projectEntities = new Set<string>()
            for (const memory of memories) {
              // 文件路径
              for (const m of memory.content.matchAll(/[\w\-/\\]+\.(?:ts|tsx|js|jsx|py|rs|go|json|yaml|yml|toml|md|css|html)\b/g)) {
                projectEntities.add(m[0])
              }
              // PascalCase 模块名
              for (const m of memory.content.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,3})\b/g)) {
                if (m[1].length > 5) projectEntities.add(m[1])
              }
            }

            // 实体节点：共享的用全局节点，独有的用项目独占节点
            for (const entityName of projectEntities) {
              const key = entityName.toLowerCase()
              if (globalEntityMap.has(key)) {
                // 跨项目共享实体 — 连接到两个项目
                const sharedNode = globalEntityMap.get(key)!
                allLinks.push({ source: projectRoot.id, target: sharedNode.id, relation: "uses", strength: 0.4 })
              } else {
                // 项目独占实体
                const node: GraphNode = {
                  id: `e-${proj.project_id}-${allNodes.length}`,
                  label: entityName,
                  type: entityName.includes(".") ? "file" : "concept",
                  size: 8,
                  color: entityName.includes(".") ? GRAPH_NODE_COLORS.file : GRAPH_NODE_COLORS.concept,
                }
                allNodes.push(node)
                globalEntityMap.set(key, node)
                allLinks.push({ source: projectRoot.id, target: node.id, relation: "contains", strength: 0.3 })
              }
            }
          }

          setGraphData({ nodes: allNodes, links: allLinks })
        } else {
          // ── 单项目模式 ──
          const results = await MemoryService.searchByProject("", projectId, 100)
          const memories = results.map((r) => ({ content: r.content || "", tags: [] as string[] }))
          const baseGraph = buildGraphFromKnowledgeStore(memories, projectName)

          // 合并 Dream 图谱
          let dreamGraph: GraphDataFromDream
          try { dreamGraph = await MemoryService.getGraphData() } catch { dreamGraph = { entities: [], relationships: [] } }
          if (dreamGraph.entities.length > 0) {
            const nodeMap = new Map(baseGraph.nodes.map(n => [n.label.toLowerCase(), n]))
            let nid = baseGraph.nodes.length + 1
            for (const entity of dreamGraph.entities) {
              if (!nodeMap.has(entity.name.toLowerCase())) {
                const node: GraphNode = {
                  id: `dream-${nid++}`, label: entity.name, type: entity.type as GraphNode["type"],
                  size: 14, color: GRAPH_NODE_COLORS[entity.type] || GRAPH_NODE_COLORS.memory,
                  description: entity.description, source: "dream",
                }
                baseGraph.nodes.push(node)
                nodeMap.set(entity.name.toLowerCase(), node)
                baseGraph.links.push({ source: `proj-${projectId}`, target: node.id, relation: "dream_extracted", strength: 0.4 })
              }
            }
          }
          setGraphData(baseGraph)
        }
      } catch {
        setGraphData({ nodes: [], links: [] })
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [open, projectId, globalView])

  if (!open) return null

  return (
    <Modal open={open} onClose={onClose} title="知识图谱" maxWidth="max-w-[95vw]">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 mb-3">
        <Network className="w-4 h-4" style={{ color: "var(--fg-tertiary)" }} />
        {projectId && (
          <button
            onClick={() => setGlobalView(!globalView)}
            className="px-2 py-0.5 rounded text-[10px] transition-all"
            style={{
              background: globalView ? "var(--bg-tertiary)" : "transparent",
              color: globalView ? "var(--fg)" : "var(--fg-tertiary)",
              border: "1px solid var(--border)",
            }}
          >
            {globalView ? "全局视图" : "当前项目"}
          </button>
        )}
      </div>

      {/* 图谱区域 */}
      <div className="rounded-lg overflow-hidden" style={{ background: "var(--bg)", border: "1px solid var(--border-subtle)" }}>
        {loading ? (
          <div className="flex items-center justify-center py-16" style={{ color: "var(--fg-tertiary)" }}>
            <div className="text-center">
              <div className="animate-spin w-6 h-6 border-2 rounded-full mx-auto mb-2" style={{ borderColor: "var(--border)", borderTopColor: "var(--fg-tertiary)" }} />
              <span className="text-xs">构建图谱中...</span>
            </div>
          </div>
        ) : (
          <MemoryGraph
            graphData={graphData}
            projectName={projectName}
            onNodeClick={setSelectedNode}
            height={graphHeight}
            hiddenRelations={hiddenRelations}
            onToggleRelation={toggleRelation}
          />
        )}
      </div>

      {/* 底部状态 */}
      <div className="flex items-center justify-between mt-3 text-[10px]" style={{ color: "var(--fg-tertiary)" }}>
        <div className="flex items-center gap-3">
          <span>拖拽旋转 · 滚轮缩放 · 点击节点</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />依赖</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />基于</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" />相似</span>
        </div>
        {selectedNode && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: selectedNode.color }} />
            {selectedNode.label}
          </span>
        )}
      </div>
    </Modal>
  )
}
