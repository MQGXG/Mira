import { describe, expect, test, beforeAll, afterAll } from 'vitest'
import * as fss from 'fs'
import { FTSMemoryProvider } from '../memory/fts-memory-provider'
import { initPlatformPaths } from '../config/paths'
import { initDatabase, runWrite, getDbAsync } from '../system/database'

// 使用隔离的 userData 目录，避免污染真实数据
const TEST_USER_DATA = process.cwd() + '/.test-data-fts'

describe('FTSMemoryProvider.searchMemoryByProject', () => {
  const provider = new FTSMemoryProvider()

  beforeAll(async () => {
    initPlatformPaths({ userData: TEST_USER_DATA, home: process.env.HOME || process.env.USERPROFILE || '/tmp' })
    // 清理遗留 fts-memory.db
    try { fss.unlinkSync(TEST_USER_DATA + '/fts-memory.db') } catch { /* 不存在 */ }

    await initDatabase()
    const db = await getDbAsync()
    // 清理旧测试会话，保证幂等
    try {
      db.run("DELETE FROM sessions WHERE project_id = 'proj_test' OR session_id IN ('sess-a','sess-b','sess-other')")
      db.run("DELETE FROM sessions WHERE project_id = 'proj_test'")
    } catch { /* 表未就绪 */ }

    // 建立主库 session → project 映射
    runWrite("INSERT OR IGNORE INTO sessions (session_id, project_id, title, workspace) VALUES (?, ?, ?, ?)", ['sess-a', 'proj_test', 'A', '/ws'])
    runWrite("INSERT OR IGNORE INTO sessions (session_id, project_id, title, workspace) VALUES (?, ?, ?, ?)", ['sess-b', 'proj_test', 'B', '/ws'])
    runWrite("INSERT OR IGNORE INTO sessions (session_id, project_id, title, workspace) VALUES (?, ?, ?, ?)", ['sess-other', 'proj_other', 'C', '/ws'])

    await provider.initialize('sess-a', TEST_USER_DATA)
    provider.indexCheckpoint('量子计算 猫态 叠加', 'sess-a')
    provider.indexCheckpoint('量子计算 纠缠 测量', 'sess-b')
    provider.indexCheckpoint('别的东西 量子', 'sess-other')
  })

  afterAll(async () => {
    await provider.shutdown()
    try { fss.unlinkSync(TEST_USER_DATA + '/fts-memory.db') } catch { /* 清理 */ }
  })

  test('按项目过滤能返回该项目会话的记忆', async () => {
    const results = await provider.searchMemoryByProject('量子计算', 'proj_test')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(['sess-a', 'sess-b']).toContain(r.sessionId)
    }
  })

  test('不返回其他项目的记忆', async () => {
    const results = await provider.searchMemoryByProject('量子', 'proj_test')
    for (const r of results) {
      expect(r.sessionId).not.toBe('sess-other')
    }
  })

  test('其他项目只返回自己的记忆', async () => {
    const results = await provider.searchMemoryByProject('量子', 'proj_other')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.sessionId).toBe('sess-other')
    }
  })

  test('不存在的项目返回空数组', async () => {
    const results = await provider.searchMemoryByProject('量子', 'proj_ghost')
    expect(results).toEqual([])
  })

  test('空 query 也能返回该项目记忆（通配）', async () => {
    const results = await provider.searchMemoryByProject('', 'proj_test')
    expect(results.length).toBeGreaterThan(0)
  })
})
