/**
 * 知识图谱数据服务 — 从记忆系统提取实体和关系
 * 增强版：共现分析 + 层级关系 + 相似度匹配 + 依赖检测
 */

import { GRAPH_NODE_COLORS } from "../theme/data-colors"

export interface GraphNode {
  id: string
  label: string
  type: "concept" | "file" | "decision" | "tool" | "project" | "memory"
  size: number
  color: string
  description?: string
  source?: string
}

export interface GraphLink {
  source: string
  target: string
  relation: string
  strength: number
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

const NODE_COLORS: Record<GraphNode["type"], string> = GRAPH_NODE_COLORS

// ── 实体提取 ────────────────────────────────────────────────

function extractEntities(text: string): Array<{ name: string; type: GraphNode["type"] }> {
  const entities: Array<{ name: string; type: GraphNode["type"] }> = []
  const seen = new Set<string>()

  const add = (name: string, type: GraphNode["type"]) => {
    const key = name.toLowerCase()
    if (!seen.has(key) && name.length > 1) {
      seen.add(key)
      entities.push({ name, type })
    }
  }

  // 文件路径（宽松匹配）
  for (const m of text.matchAll(/[\w\-/\\]+\.(?:ts|tsx|js|jsx|py|rs|go|json|yaml|yml|toml|md|css|html)\b/g)) {
    add(m[0], "file")
  }

  // 技术栈关键词
  const techMap: Record<string, GraphNode["type"]> = {
    "React": "concept", "TypeScript": "concept", "Electron": "concept",
    "Node.js": "concept", "Python": "concept", "Rust": "concept",
    "SQLite": "concept", "WebSocket": "concept", "REST API": "concept",
    "GraphQL": "concept", "MCP": "concept", "LSP": "concept",
    "Docker": "concept", "Git": "concept", "CI/CD": "concept",
    "Tailwind": "concept", "shadcn": "concept", "Vite": "concept",
    "Webpack": "concept", "pnpm": "concept", "npm": "concept",
    "Bun": "concept", "Zod": "concept", "Drizzle": "concept",
    "Effect": "concept", "SolidJS": "concept", "Ink": "concept",
    "Three.js": "concept", "D3.js": "concept",
    "OpenAI": "tool", "Anthropic": "tool", "Claude": "tool",
    "GPT": "tool", "Gemini": "tool", "Ollama": "tool",
    "Playwright": "tool", "ESLint": "tool", "Prettier": "tool",
    "Vitest": "tool", "Jest": "tool", "Turbo": "tool",
    "Bash": "tool", "PowerShell": "tool", "Shell": "tool",
    "Agent": "concept", "LLM": "concept", "RAG": "concept",
    "Embedding": "concept", "Vector": "concept", "Transformer": "concept",
  }
  for (const [name, type] of Object.entries(techMap)) {
    if (text.includes(name)) add(name, type)
  }

  // 决策/选择
  for (const m of text.matchAll(/(?:决定|选择|采用|使用|确定|采用|方案|实现|设计)[：:]?\s*([^\n。,，]{2,40})/g)) {
    add(m[1].trim(), "decision")
  }
  for (const m of text.matchAll(/(?:decided|chose|selected|using|implemented|designed)\s+([^\n.,]{2,40})/gi)) {
    add(m[1].trim(), "decision")
  }

  // 模块名（大写驼峰，如 ToolOrchestrator, ContextManager）
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,3})\b/g)) {
    const name = m[1]
    if (name.length > 5 && !/^(The|This|That|What|When|Where|How|Why|And|But|For|Not|You|Can|Has|Was|Are|Been|Will|May|Shall)$/.test(name)) {
      add(name, "concept")
    }
  }

  return entities
}

// ── 关系提取 ────────────────────────────────────────────────

function extractRelations(
  text: string,
  entityNames: Set<string>,
): Array<{ source: string; target: string; relation: string }> {
  const relations: Array<{ source: string; target: string; relation: string }> = []
  const added = new Set<string>()

  const addRel = (s: string, t: string, r: string) => {
    const key = `${s}→${t}`
    if (!added.has(key) && s !== t && entityNames.has(s) && entityNames.has(t)) {
      added.add(key)
      relations.push({ source: s, target: t, relation: r })
    }
  }

  // 关系定义：[正向, 反向, 匹配模式]
  const relationDefs: Array<[string, string, RegExp]> = [
    ["depends_on", "depended_by", /(\w[\w\s]{1,25})\s*(?:依赖|depends?\s+on|uses?|requires?|wraps?|extends?|imports?)\s+(\w[\w\s]{1,25})/gi],
    ["contains", "contained_by", /(\w[\w\s]{1,25})\s*(?:包含|contains?|includes?|has)\s+(\w[\w\s]{1,25})/gi],
    ["part_of", "has_part", /(\w[\w\s]{1,25})\s*(?:是|belongs?\s+to|part\s+of|inside|within)\s+(?:the\s+)?(\w[\w\s]{1,25})/gi],
    ["based_on", "basis_for", /(\w[\w\s]{1,25})\s*(?:基于|based\s+on|inspired\s+by|fork\s+of|derived\s+from)\s+(\w[\w\s]{1,25})/gi],
    ["replaces", "replaced_by", /(\w[\w\s]{1,25})\s*(?:替代|replaces?|instead\s+of|instead)\s+(\w[\w\s]{1,25})/gi],
  ]

  for (const [forward, backward, pattern] of relationDefs) {
    for (const m of text.matchAll(pattern)) {
      const s = m[1].trim()
      const t = m[2].trim()
      addRel(s, t, forward)
      addRel(t, s, backward)
    }
  }

  // 共现：同一段落中出现的实体互相连接
  const paragraphs = text.split(/\n{2,}/)
  for (const para of paragraphs) {
    const found: string[] = []
    for (const name of entityNames) {
      if (para.includes(name)) found.push(name)
    }
    // 所有实体两两共现
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        addRel(found[i], found[j], "co_occurs")
      }
    }
  }

  return relations
}

// ── 相似度：基于名称前缀/后缀匹配 ────────────────────────

function findSimilarPairs(names: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const arr = Array.from(names)

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i].toLowerCase()
      const b = arr[j].toLowerCase()
      // 共享前缀（3+ 字符）
      if (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3) && a !== b) {
        pairs.push([arr[i], arr[j]])
      }
      // 共享后缀
      else if (a.slice(-3) === b.slice(-3) && a.length > 4 && b.length > 4 && a !== b) {
        pairs.push([arr[i], arr[j]])
      }
    }
  }
  return pairs
}

// ── 图构建 ────────────────────────────────────────────────

export function buildGraphFromMemories(memories: Array<{ content: string; tags?: string[]; source?: string }>, projectName?: string): GraphData {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const nodeMap = new Map<string, GraphNode>()
  const linkSet = new Set<string>()

  const addLink = (source: string, target: string, relation: string, strength: number) => {
    const key = [source, target].sort().join("→")
    if (!linkSet.has(key) && source !== target) {
      linkSet.add(key)
      links.push({ source, target, relation, strength })
    }
  }

  // 中心节点 — 使用真实项目名
  const root: GraphNode = {
    id: "root", label: projectName || "知识库", type: "project",
    size: 20, color: NODE_COLORS.project, description: "项目核心知识图谱",
  }
  nodes.push(root)
  nodeMap.set("root", root)

  let nid = 1
  const allEntityNames = new Set<string>()

  // 第一遍：提取所有实体
  for (const memory of memories) {
    const entities = extractEntities(memory.content)
    for (const entity of entities) {
      allEntityNames.add(entity.name)
      if (!nodeMap.has(entity.name)) {
        const node: GraphNode = {
          id: `n${nid++}`,
          label: entity.name,
          type: entity.type,
          size: entity.type === "file" ? 7 : entity.type === "tool" ? 9 : 10,
          color: NODE_COLORS[entity.type],
          description: memory.content.slice(0, 300),
          source: memory.source,
        }
        nodes.push(node)
        nodeMap.set(entity.name, node)
      }
    }
  }

  // 第二遍：提取关系 + 共现
  for (const memory of memories) {
    const entities = extractEntities(memory.content)
    const entityNames = new Set(entities.map(e => e.name))

    // 文本级关系
    const relations = extractRelations(memory.content, entityNames)
    for (const rel of relations) {
      const sn = nodeMap.get(rel.source)
      const tn = nodeMap.get(rel.target)
      if (sn && tn) {
        addLink(sn.id, tn.id, rel.relation, 0.5)
      }
    }

    // 标签级关系
    if (memory.tags) {
      for (const tag of memory.tags) {
        for (const entity of entities) {
          const en = nodeMap.get(entity.name)
          const tn = nodeMap.get(tag)
          if (en && tn) {
            addLink(en.id, tn.id, "tagged", 0.3)
          }
        }
      }
    }
  }

  // 第三遍：连接到根节点
  for (const [name, node] of nodeMap) {
    if (name !== "root") {
      addLink("root", node.id, "contains", 0.2)
    }
  }

  // 第四遍：相似度连接
  const conceptNames = Array.from(nodeMap.keys()).filter(n => n !== "root")
  const similarPairs = findSimilarPairs(conceptNames)
  for (const [a, b] of similarPairs) {
    const na = nodeMap.get(a)
    const nb = nodeMap.get(b)
    if (na && nb) {
      addLink(na.id, nb.id, "similar_to", 0.3)
    }
  }

  return { nodes, links }
}

export function buildGraphFromKnowledgeStore(entries: Array<{ content: string; tags: string[] }>, projectName?: string): GraphData {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const nodeMap = new Map<string, GraphNode>()
  const linkSet = new Set<string>()

  const addLink = (source: string, target: string, relation: string, strength: number) => {
    const key = [source, target].sort().join("→")
    if (!linkSet.has(key) && source !== target) {
      linkSet.add(key)
      links.push({ source, target, relation, strength })
    }
  }

  // 中心节点 — 使用真实项目名
  const root: GraphNode = {
    id: "root", label: projectName || "知识库", type: "project",
    size: 24, color: NODE_COLORS.project,
    description: `${entries.length} 条知识`,
  }
  nodes.push(root)
  nodeMap.set("root", root)

  let nid = 1
  const tagNodeMap = new Map<string, GraphNode>()

  for (const entry of entries) {
    const id = `mem-${nid++}`
    const shortLabel = entry.content.slice(0, 40) + (entry.content.length > 40 ? "..." : "")
    const node: GraphNode = {
      id, label: shortLabel, type: "memory",
      size: 6, color: NODE_COLORS.memory, description: entry.content,
    }
    nodes.push(node)
    addLink("root", id, "has_knowledge", 0.2)

    // 标签节点
    for (const tag of entry.tags) {
      if (!tagNodeMap.has(tag)) {
        const tagId = `tag-${tag}`
        const tagNode: GraphNode = {
          id: tagId, label: tag, type: "concept",
          size: 12, color: NODE_COLORS.concept,
        }
        nodes.push(tagNode)
        tagNodeMap.set(tag, tagNode)
        nodeMap.set(tag, tagNode)
        addLink("root", tagId, "has_topic", 0.4)
      }
      const tagNode = tagNodeMap.get(tag)!
      addLink(tagNode.id, id, "tagged", 0.3)
    }

    // 从内容提取实体
    const entities = extractEntities(entry.content)
    for (const entity of entities) {
      if (!nodeMap.has(entity.name)) {
        const eid = `e-${nid++}`
        const eNode: GraphNode = {
          id: eid, label: entity.name, type: entity.type,
          size: entity.type === "file" ? 7 : 9,
          color: NODE_COLORS[entity.type], description: entry.content.slice(0, 200),
        }
        nodes.push(eNode)
        nodeMap.set(entity.name, eNode)
        addLink("root", eid, "contains", 0.25)
      }
      const eNode = nodeMap.get(entity.name)!
      addLink(id, eNode.id, "mentions", 0.4)

      // 连接到相关标签
      for (const tag of entry.tags) {
        const tn = tagNodeMap.get(tag)
        if (tn) addLink(eNode.id, tn.id, "related_to", 0.2)
      }
    }
  }

  // 相似度连接
  const allNames = Array.from(nodeMap.keys()).filter(n => n !== "root")
  const pairs = findSimilarPairs(allNames)
  for (const [a, b] of pairs) {
    const na = nodeMap.get(a)
    const nb = nodeMap.get(b)
    if (na && nb) addLink(na.id, nb.id, "similar_to", 0.3)
  }

  return { nodes, links }
}
