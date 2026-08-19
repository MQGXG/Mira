/**
 * 动态记忆图谱 SQLite 持久化存储
 * 复用 sql.js，写入 %APPDATA%/mira/mira.db
 * 支持 FTS5 全文索引 + 向量嵌入存储
 */

import { getDbAsync, runWrite } from "../system/database"
import type { MemoryNode, MemoryEdge, MemoryGraph, MemoryType, DecayConfig } from "./memory-node"
import { DECAY_PROFILES } from "./memory-node"
import { createEmptyGraph } from "./memory-node"
import { logError } from "../system/logger"

/** P3 优化：邻接表缓存（激活路径避免每次全量查询 memory_edges；边变更时失效） */
let adjacencyCache: Map<string, Array<{ neighborId: string; relation: string; strength: number }>> | null = null

export function invalidateAdjacencyCache(): void {
  adjacencyCache = null
}

const SCHEMA = `
  -- 主节点表
  CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'semantic',
    importance REAL DEFAULT 0.5,
    strength REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    community_id TEXT,
    decay_rate REAL DEFAULT 0.05,
    min_strength REAL DEFAULT 0.1,
    metadata_json TEXT DEFAULT '{}',
    related_nodes_json TEXT DEFAULT '[]',
    association_strengths_json TEXT DEFAULT '{}'
  );

  -- 边表
  CREATE TABLE IF NOT EXISTS memory_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    relation TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (source) REFERENCES memory_nodes(id),
    FOREIGN KEY (target) REFERENCES memory_nodes(id)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target);

  -- 社区表
  CREATE TABLE IF NOT EXISTS memory_communities (
    community_id TEXT PRIMARY KEY,
    node_ids_json TEXT NOT NULL DEFAULT '[]'
  );

  -- 元数据表
  CREATE TABLE IF NOT EXISTS memory_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- 向量嵌入表（用于语义搜索）
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    node_id TEXT PRIMARY KEY,
    embedding_json TEXT NOT NULL,
    FOREIGN KEY (node_id) REFERENCES memory_nodes(id)
  );
`

/** FTS5 全文索引（单独创建，静默失败） */
const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    node_id,
    content,
    type,
    content=memory_nodes,
    content_rowid=rowid
  );

  -- 触发器：插入时同步
  CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_nodes BEGIN
    INSERT INTO memory_fts(rowid, node_id, content, type)
    VALUES (NEW.rowid, NEW.id, NEW.content, NEW.type);
  END;

  -- 触发器：删除时同步
  CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_nodes BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, node_id, content, type)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.type);
  END;

  -- 触发器：更新时同步
  CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_nodes BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, node_id, content, type)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.content, OLD.type);
    INSERT INTO memory_fts(rowid, node_id, content, type)
    VALUES (NEW.rowid, NEW.id, NEW.content, NEW.type);
  END;
`

let initialized = false
let ftsAvailable = false

/** 初始化动态记忆数据库表 */
async function ensureSchema(): Promise<void> {
  if (initialized) return
  try {
    const db = await getDbAsync()
    db.run(SCHEMA)
    initialized = true

    // 尝试创建 FTS5 索引
    try {
      db.run(FTS_SCHEMA)
      ftsAvailable = true
    } catch {
      console.warn("[DynamicMemoryStore] FTS5 not available, using LIKE fallback")
      ftsAvailable = false
    }
  } catch (err) {
    logError("[DynamicMemoryStore] Schema init failed", err)
  }
}

/** 将 MemoryNode 转为可存储的行 */
function nodeToRow(node: MemoryNode): Record<string, unknown> {
  return {
    id: node.id,
    content: node.content,
    type: node.type,
    importance: node.importance,
    strength: node.strength,
    access_count: node.accessCount,
    last_accessed: node.lastAccessed.toISOString(),
    created_at: node.createdAt.toISOString(),
    community_id: node.communityId || null,
    decay_rate: node.decayConfig.decayRate,
    min_strength: node.decayConfig.minStrength,
    metadata_json: JSON.stringify(node.metadata),
    related_nodes_json: JSON.stringify(node.relatedNodes),
    association_strengths_json: JSON.stringify(
      Object.fromEntries(node.associationStrengths)
    ),
  }
}

/** 将行转为 MemoryNode */
function rowToNode(row: Record<string, unknown>): MemoryNode {
  const relatedNodes: string[] = JSON.parse(row.related_nodes_json as string || "[]")
  const assocObj = JSON.parse(row.association_strengths_json as string || "{}") as Record<string, number>
  const associationStrengths = new Map(Object.entries(assocObj))

  return {
    id: row.id as string,
    content: row.content as string,
    type: row.type as MemoryType,
    importance: row.importance as number,
    strength: row.strength as number,
    accessCount: row.access_count as number,
    lastAccessed: new Date(row.last_accessed as string),
    createdAt: new Date(row.created_at as string),
    communityId: row.community_id as string | undefined,
    decayConfig: {
      decayRate: row.decay_rate as number,
      minStrength: row.min_strength as number,
      consolidationThreshold: 0.5,
    },
    metadata: JSON.parse(row.metadata_json as string || "{}"),
    relatedNodes,
    associationStrengths,
  }
}

// ═══════════════════════════════════════════════════════════════
// 快速查询方法（使用索引）
// ═══════════════════════════════════════════════════════════════

/** FTS5 全文搜索节点 */
export async function searchNodesFTS(query: string, limit: number = 10): Promise<string[]> {
  await ensureSchema()
  const db = await getDbAsync()

  if (ftsAvailable) {
    // 使用 FTS5 索引（O(log n) 复杂度）
    const result = db.exec(
      "SELECT node_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?",
      [query, limit]
    )
    if (result.length > 0) {
      return result[0].values.map(row => row[0] as string)
    }
  }

  // Fallback: 使用 LIKE（O(n) 但比逐条检查快）
  const result = db.exec(
    "SELECT id FROM memory_nodes WHERE content LIKE ? LIMIT ?",
    [`%${query}%`, limit]
  )
  return result.length > 0 ? result[0].values.map(row => row[0] as string) : []
}

/** 获取节点的邻居（使用边表索引） */
export async function getNeighborsFast(nodeId: string): Promise<Array<{ neighborId: string; relation: string; strength: number }>> {
  await ensureSchema()
  const db = await getDbAsync()

  const result = db.exec(
    `SELECT target, relation, strength FROM memory_edges WHERE source = ?
     UNION
     SELECT source, relation, strength FROM memory_edges WHERE target = ?`,
    [nodeId, nodeId]
  )

  if (result.length === 0) return []

  return result[0].values.map(row => ({
    neighborId: row[0] as string,
    relation: row[1] as string,
    strength: row[2] as number,
  }))
}

/** 批量获取所有邻居（构建邻接表） */
export async function buildAdjacencyList(): Promise<Map<string, Array<{ neighborId: string; relation: string; strength: number }>>> {
  if (adjacencyCache) return adjacencyCache

  await ensureSchema()
  const db = await getDbAsync()
  const adj = new Map<string, Array<{ neighborId: string; relation: string; strength: number }>>()

  const result = db.exec("SELECT source, target, relation, strength FROM memory_edges")
  if (result.length === 0) {
    adjacencyCache = adj
    return adj
  }

  for (const row of result[0].values) {
    const source = row[0] as string
    const target = row[1] as string
    const relation = row[2] as string
    const strength = row[3] as number

    if (!adj.has(source)) adj.set(source, [])
    if (!adj.has(target)) adj.set(target, [])

    adj.get(source)!.push({ neighborId: target, relation, strength })
    adj.get(target)!.push({ neighborId: source, relation, strength })
  }

  adjacencyCache = adj
  return adj
}

// ═══════════════════════════════════════════════════════════════
// 向量嵌入存储
// ═══════════════════════════════════════════════════════════════

/** 保存节点的向量嵌入 */
export async function saveEmbedding(nodeId: string, embedding: number[]): Promise<void> {
  await ensureSchema()
  runWrite(
    "INSERT OR REPLACE INTO memory_embeddings (node_id, embedding_json) VALUES (?, ?)",
    [nodeId, JSON.stringify(embedding)]
  )
}

/** 获取节点的向量嵌入 */
export async function getEmbedding(nodeId: string): Promise<number[] | null> {
  await ensureSchema()
  const db = await getDbAsync()

  const result = db.exec(
    "SELECT embedding_json FROM memory_embeddings WHERE node_id = ?",
    [nodeId]
  )

  if (result.length === 0 || result[0].values.length === 0) return null
  return JSON.parse(result[0].values[0][0] as string) as number[]
}

/** 批量获取所有嵌入（用于向量搜索） */
export async function getAllEmbeddings(): Promise<Array<{ nodeId: string; embedding: number[] }>> {
  await ensureSchema()
  const db = await getDbAsync()

  const result = db.exec("SELECT node_id, embedding_json FROM memory_embeddings")
  if (result.length === 0) return []

  return result[0].values.map(row => ({
    nodeId: row[0] as string,
    embedding: JSON.parse(row[1] as string),
  }))
}

/** 删除节点的嵌入 */
export async function deleteEmbedding(nodeId: string): Promise<void> {
  await ensureSchema()
  runWrite("DELETE FROM memory_embeddings WHERE node_id = ?", [nodeId])
}

// ═══════════════════════════════════════════════════════════════
// 基础 CRUD（保留原有功能）
// ═══════════════════════════════════════════════════════════════

/** 加载完整图谱 */
export async function loadGraph(): Promise<MemoryGraph> {
  await ensureSchema()
  const db = await getDbAsync()
  const graph = createEmptyGraph()

  // 加载节点
  const nodeRows = db.exec("SELECT * FROM memory_nodes")
  if (nodeRows.length > 0) {
    for (const row of nodeRows[0].values) {
      const columns = nodeRows[0].columns
      const record: Record<string, unknown> = {}
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]] = row[i]
      }
      const node = rowToNode(record)
      graph.nodes.set(node.id, node)
    }
  }

  // 加载边
  const edgeRows = db.exec("SELECT * FROM memory_edges")
  if (edgeRows.length > 0) {
    for (const row of edgeRows[0].values) {
      graph.edges.push({
        source: row[1] as string,
        target: row[2] as string,
        relation: row[3] as string,
        strength: row[4] as number,
        createdAt: new Date(row[5] as string),
        lastActivated: new Date(row[5] as string),
      })
    }
  }

  // 加载社区
  const communityRows = db.exec("SELECT * FROM memory_communities")
  if (communityRows.length > 0) {
    for (const row of communityRows[0].values) {
      const nodeIds: string[] = JSON.parse(row[1] as string || "[]")
      graph.communities.set(row[0] as string, nodeIds)
    }
  }

  // 加载元数据
  const metaRows = db.exec("SELECT value FROM memory_metadata WHERE key = 'stats'")
  if (metaRows.length > 0 && metaRows[0].values.length > 0) {
    try {
      graph.metadata = JSON.parse(metaRows[0].values[0][0] as string)
    } catch { /* 使用默认值 */ }
  }

  return graph
}

/** 保存单个节点 */
export async function saveNode(node: MemoryNode): Promise<void> {
  await ensureSchema()
  const row = nodeToRow(node)
  runWrite(
    `INSERT OR REPLACE INTO memory_nodes
     (id, content, type, importance, strength, access_count, last_accessed, created_at,
      community_id, decay_rate, min_strength, metadata_json, related_nodes_json, association_strengths_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.content, row.type, row.importance, row.strength,
      row.access_count, row.last_accessed, row.created_at,
      row.community_id, row.decay_rate, row.min_strength,
      row.metadata_json, row.related_nodes_json, row.association_strengths_json,
    ]
  )
}

/** 批量保存节点（事务，激活路径用：一次 COMMIT 替代逐个写库，避免首 token 前多次落盘） */
export function saveNodesBulk(nodes: MemoryNode[]): void {
  if (nodes.length === 0) return
  try {
    runWrite("BEGIN")
    for (const node of nodes) {
      const row = nodeToRow(node)
      runWrite(
        `INSERT OR REPLACE INTO memory_nodes
         (id, content, type, importance, strength, access_count, last_accessed, created_at,
          community_id, decay_rate, min_strength, metadata_json, related_nodes_json, association_strengths_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.content, row.type, row.importance, row.strength,
          row.access_count, row.last_accessed, row.created_at,
          row.community_id, row.decay_rate, row.min_strength,
          row.metadata_json, row.related_nodes_json, row.association_strengths_json,
        ]
      )
    }
    runWrite("COMMIT")
  } catch (err) {
    runWrite("ROLLBACK")
    logError("[DynamicMemory] saveNodesBulk failed", err)
  }
}

/** 保存单条边 */
export async function saveEdge(edge: MemoryEdge): Promise<void> {
  await ensureSchema()
  runWrite(
    "INSERT INTO memory_edges (source, target, relation, strength) VALUES (?, ?, ?, ?)",
    [edge.source, edge.target, edge.relation, edge.strength]
  )
  invalidateAdjacencyCache()
}

/** 删除节点的所有边 */
export async function deleteEdgesForNode(nodeId: string): Promise<void> {
  await ensureSchema()
  runWrite("DELETE FROM memory_edges WHERE source = ? OR target = ?", [nodeId, nodeId])
  invalidateAdjacencyCache()
}

/** 删除节点 */
export async function deleteNode(nodeId: string): Promise<void> {
  await ensureSchema()
  await deleteEdgesForNode(nodeId)
  await deleteEmbedding(nodeId)
  runWrite("DELETE FROM memory_nodes WHERE id = ?", [nodeId])
}

/** 保存图谱元数据 */
export async function saveMetadata(graph: MemoryGraph): Promise<void> {
  await ensureSchema()
  runWrite(
    "INSERT OR REPLACE INTO memory_metadata (key, value) VALUES ('stats', ?)",
    [JSON.stringify(graph.metadata)]
  )
}

/** 保存社区 */
export async function saveCommunities(communities: Map<string, string[]>): Promise<void> {
  await ensureSchema()
  runWrite("DELETE FROM memory_communities")
  for (const [id, nodeIds] of communities) {
    runWrite(
      "INSERT INTO memory_communities (community_id, node_ids_json) VALUES (?, ?)",
      [id, JSON.stringify(nodeIds)]
    )
  }
}

/** 清空所有数据 */
export async function clearAll(): Promise<void> {
  await ensureSchema()
  runWrite("DELETE FROM memory_nodes")
  runWrite("DELETE FROM memory_edges")
  runWrite("DELETE FROM memory_communities")
  runWrite("DELETE FROM memory_metadata")
  runWrite("DELETE FROM memory_embeddings")
}
