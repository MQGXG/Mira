/**
 * 动态插件 VM 沙箱 — 运行期自修改的执行环境
 *
 * Agent 编写的插件代码在 node:vm 隔离 realm 中求值。沙箱暴露：
 *  - 受限 ctx facade（ctx.get/on/provide/effect/plugin，可逆注册）
 *  - harness 辅助（defineTool/registerTool）
 *  - console（插件标签）、btoa/atob、TextEncoder/TextDecoder
 *  - Node API 重定向（require/setTimeout/fetch → 提示用 ctx 服务）
 *
 * 注意：node:vm 是"协作式隔离"而非安全边界（与 dsh 一致）——
 * 依赖审批门约束模型执行的代码可信度。
 */

import { createContext, runInContext, Script } from "node:vm"
import type { Context } from "../vendor/cordis/index"

/** 沙箱暴露的受限 Cordis Context facade */
export interface CtxFacade {
  get(name: string): unknown
  on(name: string, listener: (...args: unknown[]) => unknown): () => boolean
  provide(name: string, value: unknown): () => void
  effect(fn: () => (() => void) | void, label?: string): () => void
  plugin(p: unknown, config?: unknown): unknown
  inject(deps: string[], fn: (child: Context) => unknown): unknown
}

/** 沙箱暴露的 Node API 重定向说明（调用即抛错并指引 Cordis 服务） */
const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    "Node 模块不可用。请用 ctx 服务替代 —— 例如 inject: ['tools'] 或 ctx.get('tools')",
  setTimeout:
    "定时器不可用。请在插件返回对象中声明 inject: ['timer'] 并使用 ctx.timer 服务",
  setInterval:
    "定时器不可用。请在插件返回对象中声明 inject: ['timer'] 并使用 ctx.timer 服务",
  setImmediate: "setImmediate 不可用。请使用 Promise 或 ctx 服务",
  clearTimeout: "clearTimeout 不可用",
  clearInterval: "clearInterval 不可用",
  fetch:
    "网络访问走 ctx 服务：inject: ['web'] 或参考 ctx.get('web') 提供的方法",
}

function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} 在动态插件沙箱中不可用 — ${redirect}`)
    }
  }
  return traps
}

/** 构建受限 ctx facade：插件经此注册钩子/服务（随插件 fiber 自动回滚） */
export function buildCtxFacade(ctx: Context): CtxFacade {
  const anyCtx = ctx as unknown as {
    get(name: string): unknown
    on(name: string, listener: (...args: unknown[]) => unknown): () => boolean
    provide(name: string, value: unknown): () => void
    effect(fn: () => (() => void) | void, label?: string): () => void
    plugin(p: unknown, config?: unknown): unknown
    inject(deps: string[], fn: (child: Context) => unknown): unknown
  }
  return {
    get: (name: string) => anyCtx.get(name),
    on: (name: string, listener: (...args: unknown[]) => unknown) => anyCtx.on(name, listener),
    provide: (name: string, value: unknown) => anyCtx.provide(name, value),
    effect: (fn: () => (() => void) | void, label?: string) => anyCtx.effect(fn, label),
    plugin: (p: unknown, config?: unknown) => anyCtx.plugin(p, config),
    inject: (deps: string[], fn: (child: Context) => unknown) => anyCtx.inject(deps, fn),
  }
}

/**
 * 创建沙箱 realm（contextified）
 * @param id 插件标识（console 标签 + vm 文件名）
 * @param ctx 受限 Cordis Context facade
 * @param harnessExtras 额外 harness 辅助（如 handle）
 */
export function createSandbox(id: string, ctx: CtxFacade, harnessExtras: Record<string, unknown> = {}): object {
  const sandbox: Record<string, unknown> = {
    ...nodeApiTraps(),
    console: {
      log: (...args: unknown[]) => console.log(`[dyn-plugin:${id}]`, ...args),
      info: (...args: unknown[]) => console.info(`[dyn-plugin:${id}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[dyn-plugin:${id}]`, ...args),
      error: (...args: unknown[]) => console.error(`[dyn-plugin:${id}]`, ...args),
    },
    ctx,
    harness: {
      /** 注册模型可见工具到 ctx.tools */
      registerTool: (tool: unknown) => {
        const tools = ctx.get("tools") as { register(t: unknown): void } | undefined
        tools?.register(tool)
      },
      ...harnessExtras,
    },
    btoa: (s: string) => Buffer.from(s, "utf-8").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("utf-8"),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  return sandbox
}

/** 跨 realm SyntaxError 检测（name 属性是 realm 安全标签） */
function isSyntaxError(error: unknown): error is Error {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "SyntaxError"
}

/**
 * 编译预检：不执行只编译，拦截语法错误（模型据此修正重定义）
 * @param code 插件函数体源码
 * @throws 语法错误（含行列信息 + 提示）
 */
export function precheckCode(code: string): void {
  try {
    new Script(`(async () => {\n${code}\n})()`, { filename: "mira-dyn-plugin.js" })
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(`动态插件源码语法错误：\n${(error as Error).stack ?? String(error)}\n注意：沙箱运行纯 JavaScript（非 TypeScript），且作为 async 函数体执行`)
  }
}

/**
 * 在沙箱中求值插件代码（async 函数体，必须 return 插件对象）
 * @param sandbox contextified 沙箱
 * @param code 插件函数体源码
 * @param id 插件标识
 * @param vmTimeoutMs 同步求值上限（毫秒）
 * @returns 求值结果（未收窄，由 runner 校验插件形状）
 */
export async function evaluateHostCode(sandbox: object, code: string, id: string, vmTimeoutMs: number): Promise<unknown> {
  try {
    return await runInContext(
      `(async () => {\n${code}\n})()`,
      sandbox,
      { filename: `mira-dyn-${id}.js`, timeout: vmTimeoutMs },
    )
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(`动态插件源码语法错误：\n${(error as Error).stack ?? String(error)}`)
  }
}
