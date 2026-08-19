export interface DreamResult {
  timestamp: string
  knowledgeExtracted: string[]
  outdatedRemoved: string[]
  summary: string
}

export interface DistillResult {
  timestamp: string
  workflowsFound: DistillWorkflow[]
  summary: string
}

export interface DistillWorkflow {
  id: string
  name: string
  description: string
  confidence: number
  type: "skill" | "subagent" | "command"
  steps: string[]
  examples: string[]
}

export interface GraphEntity {
  id: string
  name: string
  type: string
  description?: string
}

export interface GraphRelationship {
  source: string
  target: string
  relation: string
}

export interface GraphStore {
  entities: GraphEntity[]
  relationships: GraphRelationship[]
}

export interface KnowledgeEntry {
  id: string
  content: string
  source: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

export interface KnowledgeStore {
  entries: KnowledgeEntry[]
}

export interface LLMConfig {
  apiKey: string
  apiUrl: string
  model: string
  provider: string
}
