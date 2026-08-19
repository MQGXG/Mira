/**
 * Agent 循环服务 — ctx.agentLoop
 * 对齐 dsh AgentLoop：实现 AgentFactory（createAgent/resume），循环实现可替换（Loop 插件化）
 *
 *  - AgentLoopImpl 接口：循环契约（createAgent/resumeAgent）
 *  - DefaultAgentLoopImpl：默认实现（封装现有 Agent 类 + 注入 cordisCtx）
 *  - MiraAgentLoop：AgentFactory 实现（铸 agent scope → setup 事务 → 发布进 ctx.agents），
 *    setLoop() 可替换底层循环实现（换循环换产品）
 */

import { Service } from "../vendor/cordis/index"
import type { Context } from "../vendor/cordis/index"
import { Agent } from "../agent/agent"
import type { AgentConfig } from "../agent/constants"
import { createScope, scopeTarget } from "../scope/index"
import { ToolRegistry } from "../system/registry"
import type { MiraToolService } from "./tools"
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "./agents"
import type { MiraAgentRegistry } from "./agents"

/** Agent 循环实现契约（可替换） */
export interface AgentLoopImpl {
  /** 创建并返回 Agent（注入 cordisCtx，循环可被插件扩展） */
  createAgent(config: AgentConfig): Agent
  /** 恢复会话语义的 Agent 创建 */
  resumeAgent(config: AgentConfig): Agent
}

/** 默认循环实现：封装现有 Agent 类 */
export class DefaultAgentLoopImpl implements AgentLoopImpl {
  constructor(private rootCtx: Context) {}

  /** 获取工具注册表（优先用 ctx.tools 的实例，避免重复创建） */
  private getRegistry(): ToolRegistry {
    const tools = this.rootCtx.tools as MiraToolService | undefined
    if (tools?.registry) return tools.registry
    return new ToolRegistry()
  }

  createAgent(config: AgentConfig): Agent {
    const registry = this.getRegistry()
    return new Agent(registry, config.apiKey, config.apiUrl, config.workspace, {
      cordisCtx: this.rootCtx,
    })
  }

  resumeAgent(config: AgentConfig): Agent {
    return this.createAgent(config)
  }
}

/** 经 scope-target 载体广播 agent 会话启动事件。 */
function emitSessionStart(ctx: Context, agent: Agent, source: "startup" | "resume"): void {
  const carrier = scopeTarget(agent, agent)
  const args: unknown[] = [carrier, "agent/session-start", { source }]
  for (const callback of ctx.events.dispatch("emit", args)) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`agent "${agent.id}": agent/session-start listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`agent "${agent.id}": agent/session-start listener threw: ${String(error)}`)
    }
  }
}

/** Agent 工厂服务（对齐 dsh AgentLoop）。 */
export class MiraAgentLoop extends Service implements AgentFactory {
  /** 服务名声明（Service 构造默认名） */
  static provide = "agentLoop"
  /** 依赖：agents 注册表 + 工具/会话/llm/catalog 服务（Agent 装配面） */
  static inject = ["agents", "tools", "sessions", "llm", "catalog"]
  /** 原始 root Context（避开 traceable proxy 的 ctx 重定向） */
  private rootCtx: Context
  /** 当前循环实现（默认内置，可替换） */
  private loop: AgentLoopImpl

  constructor(ctx: Context) {
    super(ctx, "agentLoop")
    // ctx 是 plugin 激活时的 fiber ctx；Agent 需注入根 ctx proxy（与 createMiraContext 返回值同一引用）
    this.rootCtx = ctx.root
    this.loop = new DefaultAgentLoopImpl(this.rootCtx)
    // 注册为 agents 工厂（卸载时自动清除）
    ctx.effect(() => this.rootCtx.agents!.setFactory(this), "agentLoop.setFactory()")
  }

  /** 替换循环实现（插件化：换循环换产品） */
  setLoop(loop: AgentLoopImpl): void {
    this.loop = loop
  }

  /** 获取当前循环实现 */
  getLoop(): AgentLoopImpl {
    return this.loop
  }

  /**
   * 创建 agent：铸 agent scope → 构造 Agent（loop 实现）→ attachScope → setup 事务
   * → 发布进 ctx.agents（enter + announce）→ 广播 agent/session-start。
   * @param ownerCtx 拥有此事务与实时句柄的调用方 ctx（父 agent ctx）
   * @returns 已发布句柄
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = options.sessionId
    // 铸 agent scope（loopCtx = 服务装配 ctx，服务快照沿父链可解析）
    const scope = createScope(this.rootCtx, { sessionId: id })
    let agent: Agent | undefined
    let detach: (() => void) | undefined
    let setupSettled = false
    try {
      // 构造 Agent（loop 实现注入 rootCtx；sessionID 固定为作用域 id）
      const config = { ...(options.agentOptions as Partial<AgentConfig>), sessionID: id } as AgentConfig
      const created = this.loop.createAgent(config)
      created.attachScope(id, scope.ctx)
      agent = created
      // setup 事务：发布前组合 agent 作用域世界，reject 则回滚不发布
      const setupCommit = await options.setup?.(created.agentCtx!)
      setupCommit?.commit()
      setupSettled = true
      // 发布进 ctx.agents（owner = 调用方 ctx 的当前 agent；根调用为 undefined）
      const agents = this.rootCtx.agents as MiraAgentRegistry
      detach = agents.enter(created, ownerCtx.agent)
      agents.announce(created)
      emitSessionStart(this.rootCtx, created, "startup")
    } catch (error) {
      agent?.abort()
      if (setupSettled) detach?.()
      await scope.dispose()
      throw error
    }

    // 反向拆除：停循环 → 注销 → 释放作用域（memoized，竞态调用共享一次 quiescence）
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      agent?.abort()
      detach?.()
      await scope.dispose()
    })())
    return { agent: agent!, dispose }
  }

  /**
   * 恢复 agent：Mira 的会话恢复在 Agent.run 内（restoreSession 从 DB 重建），
   * 故 resume 走与 create 相同的装配路径，以 resumeSessionId 为身份。
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return this.createAgent(ownerCtx, {
      sessionId: options.resumeSessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: options.setup,
    })
  }
}

export default MiraAgentLoop