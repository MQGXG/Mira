import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { SnapshotManager } from '../session/snapshot'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'

const testDir = path.join(os.tmpdir(), `mira-snapshot-test-${randomUUID().slice(0, 8)}`)
let manager: SnapshotManager

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  manager = new SnapshotManager(testDir)
})

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
})

function write(f: string, c: string) { return fs.writeFile(f, c, 'utf-8') }
function read(f: string) { return fs.readFile(f, 'utf-8') }

describe('SnapshotManager', () => {
  test('capture 捕获文件内容', async () => {
    const fp = path.join(testDir, 'test.txt')
    await write(fp, 'hello')
    const id = await manager.capture([fp])
    expect(id).toBeTruthy()
    expect(id.startsWith('snap_')).toBe(true)
  })

  test('capture 不存在的文件记录为 null', async () => {
    const id = await manager.capture([path.join(testDir, 'nonexistent.txt')])
    expect(id).toBeTruthy()
  })

  test('restore 恢复文件内容', async () => {
    const fp = path.join(testDir, 'test.txt')
    await write(fp, 'original')
    const id = await manager.capture([fp], 'before change')
    await write(fp, 'modified')

    const restored = await manager.restore(id)
    expect(restored).toContain(fp)
    expect(await read(fp)).toBe('original')
  })

  test('restore 不存在的 ID 抛异常', async () => {
    await expect(manager.restore('nonexistent')).rejects.toThrow('Snapshot not found')
  })

  test('restore 被删除的文件（快照中 content=null）', async () => {
    const fp = path.join(testDir, 'to-delete.txt')
    await write(fp, 'temp')
    const id = await manager.capture([fp], 'before delete')
    await fs.unlink(fp)

    const restored = await manager.restore(id)
    expect(restored).toContain(fp)
  })

  test('list 返回快照列表', async () => {
    const fp = path.join(testDir, 'test.txt')
    await write(fp, 'data')
    await manager.capture([fp], 'snap 1')
    await manager.capture([fp], 'snap 2')

    const list = manager.list()
    expect(list).toHaveLength(2)
    expect(list[0].description).toBe('snap 1')
    expect(list[1].description).toBe('snap 2')
  })

  test('get 返回指定快照', async () => {
    const fp = path.join(testDir, 'test.txt')
    await write(fp, 'data')
    const id = await manager.capture([fp], 'test')
    const snap = manager.get(id)
    expect(snap).toBeDefined()
    expect(snap!.description).toBe('test')
    expect(snap!.files.size).toBe(1)
  })

  test('get 不存在的 ID 返回 undefined', () => {
    expect(manager.get('nonexistent')).toBeUndefined()
  })

  test('delete 删除快照', async () => {
    const fp = path.join(testDir, 'test.txt')
    await write(fp, 'data')
    const id = await manager.capture([fp])
    expect(manager.delete(id)).toBe(true)
    expect(manager.get(id)).toBeUndefined()
  })

  test('delete 不存在的 ID 返回 false', () => {
    expect(manager.delete('nonexistent')).toBe(false)
  })

  test('快照数上限 50', async () => {
    const fp = path.join(testDir, 'test.txt')
    for (let i = 0; i < 55; i++) {
      await write(fp, `v${i}`)
      await manager.capture([fp])
    }
    expect(manager.list().length).toBeLessThanOrEqual(50)
  })
})
