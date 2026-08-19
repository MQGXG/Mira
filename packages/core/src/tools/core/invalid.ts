/**
 * invalid 工具 — 不可见 catch-all 修复工具（参考 opencode）
 *
 * 该工具不出现在暴露给 LLM 的工具集中（agent.ts prepareRun 会过滤），
 * 仅作为"工具调用自愈修复"的落点：当 LLM 调用不存在/拼写错误/参数畸形的
 * 工具时，turn-runner 的 repair 钩子把调用改写成 invalid，返回可读错误
 * 回流给 LLM，使其自我纠正，回合不中断。
 */

import { z } from "zod"
import { make } from "../../shared/tool"

export const invalidTool = make({
  name: "invalid",
  description: "Do not use.",
  inputSchema: z.object({
    tool: z.string().describe("The name of the tool that was attempted"),
    error: z.string().describe("The validation error message"),
  }),
  outputSchema: z.string(),
  isReadOnly: true,
  execute(input) {
    return Promise.resolve({
      success: true,
      output: `The arguments provided to the tool "${input.tool}" are invalid: ${input.error}. Correct the tool name and arguments, then retry. If unsure which tool to use, review the available tools.`,
    })
  },
})
