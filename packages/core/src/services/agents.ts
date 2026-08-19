/**
 * Agent 服务 — ctx.agents
 * 对齐 dsh AgentRegistry：实时注册表 + 工厂委托 + 进程内发起者因果链
 *
 * Agent 创建由工厂实现（ctx.agentLoop）经 setFactory 注册，create/resume 委托给工厂；
 * 子 Agent 也注册进本注册表（同一实时面），Subagent 状态机保留在 orchestrate/subagent.ts。
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { isPromise } from "node:util/types"
import { getTraceable, Service, symbols } from "../vendor/cordis/index"
import type { Context, Fiber } from "../vendor/cordis/index"
import { FiberState } from "../vendor/cordis/index"
import { scopeTarget } from "../scope/index"
import type { Scoped } from "../scope/index"
import type { Agent } from "../agent/agent"
import type { AgentConfig } from "../agent/constants"

/** 未发布 Agent 在发布提交点校验其 setup 贡献的同步 finalizer */
export interface AgentSetupCommit {
  /**
   * 在发布前立即校验并提交预备的 setup。
   * @throws 发布必须回滚未发布的 Agent。
   */
  commit(): void
}

/** 组合一个未发布 Agent 作用域，可选返回其发布提交。 */
export type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/** 程序化创建 Agent 的选项（经注册表工厂）。 */
export interface CreateAgentOptions {
  /** 实时 agent/session 共享身份。 */
  readonly sessionId: string
  /** 会话创建元数据（cwd / parentSession 分叉谱系等）。 */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: string
    readonly origin?: "subagent"
    readonly delegationDepth?: number
  }
  /** 每个 agent 的循环选项（模型/凭据等，AgentConfig 子集）。 */
  readonly agentOptions?: Partial<AgentConfig>
  /** 可选创建期取消信号；句柄可见前分离。 */
  readonly signal?: AbortSignal
  /** 创建期对 agent 作用域世界的组合（见 dsh CreateAgentOptions.setup 契约）。 */
  readonly setup?: AgentSetup
}

/** 恢复已持久化会话上 agent 的选项。 */
export interface ResumeAgentOptions {
  /** 待加载的已持久化会话 id，同时用作实时 agent/session 身份。 */
  readonly resumeSessionId: string
  /** 每个 agent 的循环选项。 */
  readonly agentOptions?: Partial<AgentConfig>
  /** 可选取消信号。 */
  readonly signal?: AbortSignal
  /** 恢复期组合（契约同 CreateAgentOptions.setup）。 */
  readonly setup?: AgentSetup
}

/** 创建/恢复返回的受所有权 agent 及其 disposer。 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/** 循环实现提供给注册表的创建工厂（dsh AgentFactory 对齐）。 */
export interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** 创建/恢复被调用但工厂尚未注册时的错误。 */
const NO_FACTORY_MESSAGE = "no agent factory registered (load an agent-loop plugin)"
const NO_INITIATOR_MESSAGE = "no initiating agent is active"
const DISPOSED_INITIATOR_MESSAGE = "agent initiator scope is disposed"

/** 一个精确注册表条目的全部可变生命周期状态。 */
interface AgentEntry {
  readonly id: string
  readonly agent: Agent
  /** 运行时创建者 agent 所有权；独立于持久会话谱系。 */
  readonly owner: Agent | undefined
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
}

/** 一个跟踪边界及其继承的嵌套链。 */
interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** 普通持有器防止 Cordis 在调用方上下文已知前追踪工厂字段。 */
interface FactorySlot {
  readonly target: AgentFactory
}

/**
 * Agent 服务（ctx.agents）：跟踪实时 agent，并携带发起 Agent 穿过一条
 * 进程内异步驱动链。创建由实现 AgentFactory 的插件提供（ctx.agentLoop）。
 */
export class MiraAgentRegistry extends Service {
  private store = new Map<string, AgentEntry>()
  private factory: FactorySlot | undefined
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: "active" | "closing" | "disposed" = "active"
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, "agents")
    // ctx.agent DX accessor：每个上下文默认 undefined（经 Agent 作用域 own property 覆盖）
    ctx.accessor("agent", { get: () => undefined })
    ctx.on("internal/status", (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    ctx.effect(function* (this: MiraAgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), "agents.initiatorLifecycle()")
  }

  /** 读取继承的发起 Agent（日志/追踪/归属），agentless 调用返回 undefined。 */
  currentInitiator(): Agent | undefined {
    this.assertInitiatorsReadable()
    return this.initiators.getStore()
  }

  /** 读取发起 Agent，无边界时抛错。 */
  requireInitiator(): Agent {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /** 以精确 Agent 作为进程内发起者运行操作；保留返回值。 */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }

  /** 在隐藏任何继承发起 Agent 的边界内运行操作。 */
  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)
  }

  /** 注册创建工厂（循环在构造时调用，effect-scoped）。 */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error("an agent factory is already registered")
      this.factory = { target: factory }
      return () => { this.factory = undefined }
    }, "agents.setFactory()")
    return dispose
  }

  private requireFactory(): FactorySlot {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /** 经注册工厂创建并发布新 agent（构造 agent 与它的会话）。 */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  /** 经注册工厂加载持久化会话并恢复 agent。 */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

  /**
   * 注册实时 agent。重复 id 抛错。注册发 agent/created，调用 fiber 卸载发
   * agent/disposed（均以 scopeTarget(agent, agent) 为载体作用域过滤）。
   * @returns 精确 Cordis effect disposer（单次；复合 effect 可 yield 它嵌套拆除顺序）。
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: MiraAgentRegistry) {
      yield this.enter(agent, this.ctx.agent)
      this.announce(agent)
    }.bind(this), "agents.register()")
    return dispose
  }

  /**
   * 插入已构造 agent 而不宣布。异步工厂的进阶生命周期原语：先完成 setup
   * （未发布），再把返回的 detach 闭包装进其预装的复合拆除，然后 announce。
   */
  enter(agent: Agent, owner: Agent | undefined): () => void {
    const id = agent.id
    if (id === undefined || id === "") {
      throw new Error("agent id is not set (attach an agent scope id first)")
    }
    const carrier = scopeTarget(agent, agent)
    // 权威碰撞边界：并发 create/resume 可能都 prepare，但只有一个精确条目发布
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const entry: AgentEntry = {
      id,
      agent,
      owner,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    this.store.set(id, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** 移除一个精确已进入 agent，并在已宣布时发出配对的处置。 */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** 经条目的稳定载体发出配对处置边。 */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, "agent/disposed", { agent: entry.agent }]
    for (const callback of this.ctx.events.dispatch("emit", args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /** 宣布之前经 enter 插入的 agent。 */
  announce(agent: Agent): void {
    const id = agent.id
    if (id === undefined) throw new Error("announce() requires an agent with an id")
    const entry = this.store.get(id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    entry.announcing = true
    entry.announced = true
    const args: unknown[] = [entry.carrier, "agent/created", { agent: entry.agent }]
    try {
      for (const callback of this.ctx.events.dispatch("emit", args)) {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /** 查找实时 agent。 */
  get(id: string): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /** 测试实时 agent 是否由一个精确父 agent 的作用域上下文创建。 */
  isOwnedBy(id: string, owner: Agent): boolean {
    return this.store.get(id)?.owner === owner
  }

  /** 全部实时 agent（注册序）。 */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }

  /** 全部顶层实时 agent（无运行时 owner；持久会话谱系不影响此关系）。 */
  roots(): Agent[] {
    return [...this.store.values()]
      .filter(entry => entry.owner === undefined)
      .map(entry => entry.agent)
  }

  private closeInitiators(): void {
    if (this.initiatorState === "active") this.initiatorState = "closing"
  }

  private disposeInitiators(): Promise<void> {
    return (this.initiatorDisposal ??= (async () => {
      this.closeInitiators()
      this.releaseReentrantInitiatorRuns()
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      this.initiatorState = "disposed"
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== "active") throw new Error(DISPOSED_INITIATOR_MESSAGE)
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    this.activeInitiatorRuns += 1
    let result: T
    try {
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        this.releaseInitiatorRun(run)
      }
    } else {
      this.releaseInitiatorRun(run)
    }
    return result
  }

  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    if (this.initiatorState === "disposed") throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

export default MiraAgentRegistry
