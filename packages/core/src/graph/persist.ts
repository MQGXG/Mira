/**
 * Graph 持久化 — 图状态/检查点写入磁盘
 * 复用 CheckpointProvider 的 userData 目录约定：
 *   {userData}/graphs/{graphId}/{runId}.json
 */

import { join } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"
import type { GraphCheckpoint } from "./types"

function graphsDir(): string {
  return join(getPlatformPaths().userData, "graphs")
}

function runPath(graphId: string, runId: string): string {
  return join(graphsDir(), graphId, `${runId}.json`)
}

export class GraphPersist {
  /** 保存检查点 */
  saveCheckpoint(checkpoint: GraphCheckpoint): void {
    try {
      const dir = join(graphsDir(), checkpoint.graphId)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        runPath(checkpoint.graphId, checkpoint.runId),
        JSON.stringify(checkpoint, null, 2),
        "utf-8",
      )
    } catch {
      /* 静默：持久化失败不阻塞执行 */
    }
  }

  /** 恢复检查点 */
  loadCheckpoint(graphId: string, runId: string): GraphCheckpoint | null {
    try {
      const file = runPath(graphId, runId)
      if (!fs.existsSync(file)) return null
      return JSON.parse(fs.readFileSync(file, "utf-8")) as GraphCheckpoint
    } catch {
      return null
    }
  }

  /** 列出某图的全部检查点（按时间倒序） */
  listCheckpoints(graphId: string): GraphCheckpoint[] {
    try {
      const dir = join(graphsDir(), graphId)
      if (!fs.existsSync(dir)) return []
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(join(dir, f), "utf-8")) as GraphCheckpoint
          } catch {
            return null
          }
        })
        .filter((c): c is GraphCheckpoint => c !== null)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    } catch {
      return []
    }
  }

  /** 删除检查点 */
  deleteCheckpoint(graphId: string, runId: string): void {
    try {
      const file = runPath(graphId, runId)
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch {
      /* 静默 */
    }
  }
}
