// vi.mock 的 factory 会被 hoist 到 import 之前，只能使用 require 获取运行时依赖（vitest 官方推荐模式），
// 因此 mock 相关的动态类型规则在此文件不适用，按需禁用。
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const children: Array<{
    pid: number
    killed: boolean
    exitCode: number | null
    signalCode: string | null
    stdout: any
    stderr: any
    emit: (event: string, ...args: unknown[]) => boolean
    once: (event: string, fn: () => void) => void
    kill: () => boolean
  }> = []
  return { children }
})

vi.mock('child_process', () => {
  const { EventEmitter } = require('node:events')
  const { Readable } = require('node:stream')

  class FakeChild extends EventEmitter {
    pid: number
    killed = false
    exitCode: number | null = null
    signalCode: string | null = null
    stdout: any
    stderr: any
    constructor(pid: number) {
      super()
      this.pid = pid
      this.stdout = new Readable({ read() {} })
      this.stderr = new Readable({ read() {} })
    }
    kill(): boolean {
      this.killed = true
      return true
    }
  }

  let pidCounter = 0
  let lastSidecar: FakeChild | null = null
  return {
    spawn: vi.fn((cmd: string, _args: string[]) => {
      const child = new FakeChild(++pidCounter)
      if (cmd.includes('taskkill')) {
        // 模拟 taskkill 立即完成，并同步强杀目标 sidecar 进程（exit code 1）
        process.nextTick(() => {
          child.emit('exit', 0)
          const target = lastSidecar
          if (target) {
            target.exitCode = 1
            target.emit('exit', 1)
          }
        })
      } else {
        lastSidecar = child
        mocks.children.push(child as never)
      }
      return child
    }),
  }
})

import { ServerManager } from '../system/server-manager'
import { spawn } from 'child_process'

/** 最近一次 spawn 的子进程 */
function lastChild(): (typeof mocks.children)[number] {
  return mocks.children[mocks.children.length - 1]
}

/** 向子进程 stdout 推送一条 ready JSON 行 */
function emitReady(child: (typeof mocks.children)[number], port: number, token: string): void {
  child.stdout.push(`${JSON.stringify({ event: 'ready', port, token })}\n`)
}

const BASE_OPTS = {
  port: 0,
  useTsx: true,
  userData: '/tmp/mira-test',
  timeout: 2000,
  // 显式传入 serverEntry，避免 constructor 触发 __dirname（ESM 测试环境不可用）
  serverEntry: '/fake/sidecar.js',
}

describe('ServerManager', () => {
  test('start 后 waitForReady 返回新进程的端口与 token', async () => {
    const sm = new ServerManager(BASE_OPTS)
    const ready = sm.start()
    emitReady(lastChild(), 4444, 'tok')
    const info = await ready
    expect(info).toEqual({ port: 4444, token: 'tok' })
    expect(sm.port).toBe(4444)
    expect(sm.token).toBe('tok')
  })

  test('重启后返回新端口而非陈旧端口（waitForReady 陈旧端口短路回归）', async () => {
    const sm = new ServerManager(BASE_OPTS)

    const p1 = sm.start()
    const c1 = lastChild()
    emitReady(c1, 1111, 't1')
    expect((await p1).port).toBe(1111)

    // 模拟旧进程退出
    c1.emit('exit', 0)
    expect(sm.running).toBe(false)

    const p2 = sm.start()
    const c2 = lastChild()
    expect(c2).not.toBe(c1)
    emitReady(c2, 2222, 't2')
    const info2 = await p2
    // 修复前：start() 未重置 resolvedPort，waitForReady 短路返回旧端口 1111
    expect(info2.port).toBe(2222)
    expect(info2.token).toBe('t2')
    expect(sm.port).toBe(2222)
  })

  test('启动超时 reject，且无残留的 unhandledRejection', async () => {
    const sm = new ServerManager({ ...BASE_OPTS, timeout: 50 })
    await expect(sm.start()).rejects.toThrow('Server startup timed out')
  })

  test('进程在就绪前退出时 start reject，避免 request 永久挂起', async () => {
    const sm = new ServerManager(BASE_OPTS)
    const p = sm.start()
    lastChild().emit('exit', 1)
    await expect(p).rejects.toThrow(/before ready/)
  })

  test('重复调用 start 幂等：旧进程存活时会先 stop 再启动新进程', async () => {
    const sm = new ServerManager(BASE_OPTS)

    const p1 = sm.start()
    const c1 = lastChild()
    emitReady(c1, 3333, 't3')
    expect((await p1).port).toBe(3333)

    // 不手动退出 c1，直接再次 start → 内部会 stop 掉 c1 再 spawn c2（stop 为异步，需等待新进程出现）
    const p2 = sm.start()
    await vi.waitFor(() => {
      expect(lastChild()).not.toBe(c1)
    })
    const c2 = lastChild()
    emitReady(c2, 4444, 't4')
    expect((await p2).port).toBe(4444)
  })

  test('spawn env 注入 MIRA_VERSION（崩溃标记/health 版本不再恒为 dev）', async () => {
    const sm = new ServerManager({ ...BASE_OPTS, version: '9.9.9-test' })
    const ready = sm.start()
    emitReady(lastChild(), 5555, 't5')
    await ready

    const calls = vi.mocked(spawn).mock.calls
    const lastCall = calls[calls.length - 1]
    const env = lastCall[2].env as NodeJS.ProcessEnv
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.MIRA_VERSION).toBe('9.9.9-test')
  })

  test('未传 version 时不注入 MIRA_VERSION（避免字面量 "undefined"）', async () => {
    const sm = new ServerManager(BASE_OPTS)
    const ready = sm.start()
    emitReady(lastChild(), 6666, 't6')
    await ready

    const calls = vi.mocked(spawn).mock.calls
    const lastCall = calls[calls.length - 1]
    const env = lastCall[2].env as NodeJS.ProcessEnv
    expect(env.MIRA_VERSION).toBeUndefined()
  })
})
