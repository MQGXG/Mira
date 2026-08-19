import * as fs from "fs"
import type { GraphEntity, GraphRelationship, GraphStore } from "./dream-types"

export function extractLightweightEntities(text: string, store: GraphStore): { entities: GraphEntity[]; relationships: GraphRelationship[] } {
  const newEntities: GraphEntity[] = []
  const newRelationships: GraphRelationship[] = []
  const existingNames = new Set(store.entities.map(e => e.name.toLowerCase()))

  for (const m of text.matchAll(/[\w\-/\\]+\.(?:ts|tsx|js|jsx|py|rs|go|json|yaml|yml|toml|md|css|html)\b/g)) {
    const name = m[0]
    if (!existingNames.has(name.toLowerCase())) {
      newEntities.push({ id: "", name, type: "file" })
      existingNames.add(name.toLowerCase())
    }
  }

  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,3})\b/g)) {
    const name = m[1]
    if (name.length > 5 && !/^(The|This|That|What|When|Where|How|Why|And|But|For|Not|You|Can|Has|Was|Are|Been|Will|May|Shall|Some|More|Most|Other|Each|Every|Both|Few|Many|Much|Such)$/.test(name)) {
      if (!existingNames.has(name.toLowerCase())) {
        newEntities.push({ id: "", name, type: "concept" })
        existingNames.add(name.toLowerCase())
      }
    }
  }

  const sentences = text.split(/[。！？\n.!?]+/)
  for (const sentence of sentences) {
    const found: string[] = []
    for (const entity of newEntities) {
      if (sentence.includes(entity.name)) found.push(entity.name)
    }
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        newRelationships.push({ source: found[i], target: found[j], relation: "co_occurs" })
      }
    }
  }

  return { entities: newEntities, relationships: newRelationships }
}

export function mergeGraphData(store: GraphStore, newEntities: GraphEntity[], newRelationships: GraphRelationship[]): void {
  const existingNames = new Set(store.entities.map(e => e.name.toLowerCase()))
  for (const entity of newEntities) {
    if (!existingNames.has(entity.name.toLowerCase())) {
      store.entities.push({
        id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: entity.name,
        type: entity.type,
        description: entity.description,
      })
      existingNames.add(entity.name.toLowerCase())
    }
  }

  const existingRels = new Set(store.relationships.map(r => `${r.source.toLowerCase()}→${r.target.toLowerCase()}→${r.relation}`))
  for (const rel of newRelationships) {
    const key = `${rel.source.toLowerCase()}→${rel.target.toLowerCase()}→${rel.relation}`
    if (!existingRels.has(key)) {
      store.relationships.push(rel)
      existingRels.add(key)
    }
  }
}

export function loadGraphStore(graphPath: string): GraphStore {
  try {
    if (fs.existsSync(graphPath)) return JSON.parse(fs.readFileSync(graphPath, "utf-8")) as GraphStore
  } catch { /* 忽略 */ }
  return { entities: [], relationships: [] }
}

export function saveGraphStore(store: GraphStore, graphPath: string): void {
  try { fs.writeFileSync(graphPath, JSON.stringify(store, null, 2), "utf-8") } catch { /* 静默 */ }
}
