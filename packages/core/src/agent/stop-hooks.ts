import type { LLMMessage } from "../llm/client"
import type { ContextManager } from "../session/context"
import type { DreamDistillManager } from "../orchestrate/dream"
import type { MemoryManager } from "../memory/manager"

export interface StopContext {
  sessionID: string
  workspace: string
  messages: LLMMessage[]
  contextManager: ContextManager
  memoryManager?: MemoryManager
  dreamDistillManager?: DreamDistillManager
  budget?: { remaining: number; total: number }
}

export interface StopResult {
  additionalMessages: string[]
  shouldContinue: boolean
}

export type StopHook = (ctx: StopContext) => Promise<StopResult>

const hooks: StopHook[] = []

export function registerStopHook(hook: StopHook): void {
  // 幂等注册：相同 hook 不重复添加，防止多次 new Agent 导致钩子累积泄漏
  if (!hooks.includes(hook)) {
    hooks.push(hook)
  }
}

export async function runStopHooks(ctx: StopContext): Promise<StopResult> {
  const additionalMessages: string[] = []
  let shouldContinue = false

  for (const hook of hooks) {
    try {
      const result = await hook(ctx)
      if (result.additionalMessages.length > 0) {
        additionalMessages.push(...result.additionalMessages)
      }
      if (result.shouldContinue) shouldContinue = true
    } catch {
      // Stop hook 失败不阻塞主流程
    }
  }

  return { additionalMessages, shouldContinue }
}

export async function autoDreamHook(ctx: StopContext): Promise<StopResult> {
  if (!ctx.dreamDistillManager || !ctx.contextManager.shouldAutoDream?.()) {
    return { additionalMessages: [], shouldContinue: false }
  }
  try {
    await ctx.dreamDistillManager.autoDream()
  } catch { /* 不阻塞 */ }
  return { additionalMessages: [], shouldContinue: false }
}

export async function memoryPromoteHook(ctx: StopContext): Promise<StopResult> {
  if (!ctx.memoryManager) return { additionalMessages: [], shouldContinue: false }
  try {
    await ctx.memoryManager.promoteMemories(ctx.sessionID)
  } catch { /* 不阻塞 */ }
  return { additionalMessages: [], shouldContinue: false }
}
