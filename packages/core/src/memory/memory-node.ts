/**
 * 记忆节点类型定义
 * 模拟人类记忆系统：强度、衰减、关联、激活
 */

/** 记忆类型 */
export type MemoryType = "semantic" | "episodic" | "procedural" | "declarative"

/** 记忆衰减配置 */
export interface DecayConfig {
  /** 衰减率（0-1，越大衰减越快） */
  decayRate: number
  /** 最小强度阈值（低于此值视为遗忘） */
  minStrength: number
  /** 固化阈值（高于此值记忆被强化） */
  consolidationThreshold: number
}

/** 记忆节点 */
export interface MemoryNode {
  /** 唯一标识 */
  id: string
  /** 记忆内容 */
  content: string
  /** 记忆类型 */
  type: MemoryType
  /** 当前强度（0-1） */
  strength: number
  /** 基础重要性（0-1，由内容决定） */
  importance: number
  /** 访问次数 */
  accessCount: number
  /** 最后访问时间 */
  lastAccessed: Date
  /** 创建时间 */
  createdAt: Date
  /** 衰减配置 */
  decayConfig: DecayConfig
  /** 社区ID（Leiden 聚类） */
  communityId?: string
  /** 关联节点ID列表 */
  relatedNodes: string[]
  /** 关联强度（节点ID → 强度） */
  associationStrengths: Map<string, number>
  /** 元数据 */
  metadata: Record<string, unknown>
}

/** 记忆边（关联） */
export interface MemoryEdge {
  /** 源节点ID */
  source: string
  /** 目标节点ID */
  target: string
  /** 关联类型 */
  relation: string
  /** 关联强度（0-1） */
  strength: number
  /** 创建时间 */
  createdAt: Date
  /** 最后激活时间 */
  lastActivated: Date
}

/** 记忆图谱 */
export interface MemoryGraph {
  /** 所有节点 */
  nodes: Map<string, MemoryNode>
  /** 所有边 */
  edges: MemoryEdge[]
  /** 社区映射 */
  communities: Map<string, string[]>
  /** 图谱元数据 */
  metadata: {
    totalNodes: number
    totalEdges: number
    totalCommunities: number
    lastUpdated: Date
  }
}

/** 激活结果 */
export interface ActivationResult {
  /** 激活的节点（按强度排序） */
  nodes: MemoryNode[]
  /** 激活路径（用于可视化） */
  paths: Array<{ from: string; to: string; strength: number }>
  /** 激活强度（0-1） */
  activationStrength: number
  /** 是否触发了突然想起 */
  spontaneousRecall: boolean
}

/** 预定义衰减配置 */
export const DECAY_PROFILES: Record<string, DecayConfig> = {
  /** 核心代码：几乎不遗忘 */
  core_code: {
    decayRate: 0.01,
    minStrength: 0.3,
    consolidationThreshold: 0.7,
  },
  /** 文档：中等衰减 */
  documentation: {
    decayRate: 0.05,
    minStrength: 0.1,
    consolidationThreshold: 0.5,
  },
  /** 临时笔记：快速遗忘 */
  temp_notes: {
    decayRate: 0.1,
    minStrength: 0.05,
    consolidationThreshold: 0.3,
  },
  /** 重要决策：慢速衰减 */
  decisions: {
    decayRate: 0.02,
    minStrength: 0.2,
    consolidationThreshold: 0.6,
  },
  /** 会话记忆：快速衰减 */
  episodic: {
    decayRate: 0.08,
    minStrength: 0.05,
    consolidationThreshold: 0.4,
  },
}

/** 创建默认记忆节点 */
export function createMemoryNode(
  id: string,
  content: string,
  type: MemoryType = "semantic",
  decayProfile: keyof typeof DECAY_PROFILES = "documentation"
): MemoryNode {
  const now = new Date()
  return {
    id,
    content,
    type,
    strength: 1.0,
    importance: 0.5,
    accessCount: 0,
    lastAccessed: now,
    createdAt: now,
    decayConfig: { ...DECAY_PROFILES[decayProfile] },
    relatedNodes: [],
    associationStrengths: new Map(),
    metadata: {},
  }
}

/** 创建记忆边 */
export function createMemoryEdge(
  source: string,
  target: string,
  relation: string,
  strength: number = 0.5
): MemoryEdge {
  const now = new Date()
  return {
    source,
    target,
    relation,
    strength,
    createdAt: now,
    lastActivated: now,
  }
}

/** 创建空图谱 */
export function createEmptyGraph(): MemoryGraph {
  return {
    nodes: new Map(),
    edges: [],
    communities: new Map(),
    metadata: {
      totalNodes: 0,
      totalEdges: 0,
      totalCommunities: 0,
      lastUpdated: new Date(),
    },
  }
}
