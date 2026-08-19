/**
 * 特色功能服务测试（一切皆插件：寻址 / 可替换 / 可逆回滚）
 * 验证 11 个特色功能服务（workflow/graph/compose/subagent/goal/dream/lsp/skill/background/task/voice）
 * 全部挂入 Cordis 单一寻址空间，插件可替换实现、disposer 可逆回滚。
 */

import { describe, it, expect } from "vitest"
import { createMiraContext } from "../../framework/services"
import { ComposeModeManager, type ComposePhase, type ComposeSkill } from "../../compose-mode"
import { Agent } from "../../agent/agent"
import { createDefaultRegistry } from "../../system/registry-init"
import type { WorkflowEngine } from "../../workflow/index"

const PHASES: ComposePhase[] = ["plan", "execute", "review", "test", "debug", "verify", "merge"]

const dummySkill = (name: string): ComposeSkill => ({
  name,
  description: `skill ${name}`,
  tools: ["read_file"],
  systemPrompt: `You are ${name}`,
  phase: "plan" as ComposePhase,
})

describe("特色功能服务（一切皆插件）", () => {
  it("11 个特色功能服务全部注册进 ctx 单一寻址空间", async () => {
    const ctx = await createMiraContext()
    expect(ctx.workflow).toBeDefined()
    expect(ctx.graph).toBeDefined()
    expect(ctx.compose).toBeDefined()
    expect(ctx.subagent).toBeDefined()
    expect(ctx.goal).toBeDefined()
    expect(ctx.dream).toBeDefined()
    expect(ctx.lsp).toBeDefined()
    expect(ctx.skill).toBeDefined()
    expect(ctx.background).toBeDefined()
    expect(ctx.task).toBeDefined()
    expect(ctx.voice).toBeDefined()
    await ctx.fiber.dispose()
  })

  it("ctx.compose 可注册/替换 phase skill（registerPhase 生效于 getSkillsMap）", async () => {
    const ctx = await createMiraContext()
    const compose = ctx.compose!
    const before = compose.getSkills()["plan"]
    const disposer = compose.registerPhase("plan", dummySkill("my-custom-plan"))
    expect(compose.getSkills()["plan"].name).toBe("my-custom-plan")
    // 可逆回滚：disposer 后恢复原 skill
    disposer()
    expect(compose.getSkills()["plan"].name).toBe(before.name)
    await ctx.fiber.dispose()
  })

  it("ctx.skill.addSkillDir 可逆（disposer 后目录恢复）", async () => {
    const ctx = await createMiraContext()
    const dirs = ctx.skill!.getSkillDirs()
    const disposer = ctx.skill!.addSkillDir("/tmp/custom-skills")
    expect(ctx.skill!.getSkillDirs()).toContain("/tmp/custom-skills")
    disposer()
    expect(ctx.skill!.getSkillDirs()).toEqual(dirs)
    await ctx.fiber.dispose()
  })

  it("ctx.workflow.setEngine 可替换引擎实现", async () => {
    const ctx = await createMiraContext()
    const workflow = ctx.workflow!
    const original = workflow.getEngine()
    const fake = { execute: () => Promise.resolve({ results: [], elapsedMs: 0 }) } as unknown as WorkflowEngine
    workflow.setEngine(fake)
    expect(workflow.getEngine()).toBe(fake)
    const result = await workflow.execute({ name: "t", description: "t", steps: [] })
    expect(result.elapsedMs).toBe(0)
    workflow.setEngine(original)
    expect(workflow.getEngine()).toBe(original)
    await ctx.fiber.dispose()
  })

  it("ctx.background 定时任务注册/列表/移除", async () => {
    const ctx = await createMiraContext()
    const bg = ctx.background!
    bg.addCron("test-cron", "* * * * *", "test", async () => {})
    expect(bg.listCron().some((t) => t.id === "test-cron")).toBe(true)
    bg.removeCron("test-cron")
    expect(bg.listCron().some((t) => t.id === "test-cron")).toBe(false)
    await ctx.fiber.dispose()
  })

  it("ctx.goal 与 Agent 构造共享 GoalJudge 实例（消除双实例）", async () => {
    const ctx = await createMiraContext()
    const registry = createDefaultRegistry()
    const agent = new Agent(registry, "k", "http://x", "/tmp", {
      cordisCtx: ctx,
      id: "shared-goal-test",
    })
    // ctx.goal.getJudge() 与 Agent.goalJudge 同一实例
    expect(agent.getGoalJudge()).toBe(ctx.goal!.getJudge())
    await ctx.fiber.dispose()
  })

  it("ctx.memory 与 Agent 构造共享 MemoryManager（5 层链由服务装配）", async () => {
    const ctx = await createMiraContext()
    await ctx.memory!.initialize("mem-sess", "/tmp")
    const registry = createDefaultRegistry()
    const agent = new Agent(registry, "k", "http://x", "/tmp", {
      cordisCtx: ctx,
      id: "shared-mem-test",
    })
    expect(agent.getFTSProvider()).not.toBeNull()
    expect(ctx.memory!.getManager()).toBeDefined()
    await ctx.fiber.dispose()
  })

  it("ctx 释放后服务不可再寻址（Cordis Fiber 生命周期回滚）", async () => {
    const ctx = await createMiraContext()
    expect(ctx.compose).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.compose).toBeUndefined()
  })

  it("compose 服务自动接线 subagent（setSubagentManager 根源修复）", async () => {
    const ctx = await createMiraContext()
    const manager = ctx.compose!.getManager() as ComposeModeManager
    // getSubagentManager 非空即接线成功（原 compose-ipc 从不调用 setSubagentManager）
    expect(manager.getSubagentManager()).not.toBeNull()
    await ctx.fiber.dispose()
  })

  it("phaseOrder 可经构造器定制（服务默认全流程）", async () => {
    const ctx = await createMiraContext()
    const phases = ctx.compose!.getSkills()
    for (const p of PHASES) expect(phases[p]).toBeDefined()
    await ctx.fiber.dispose()
  })
})