import { z } from "zod"
import { make } from "../../shared/tool"
import { getCodeRuntime } from "../../capability/code-runtime"

export const codeExecTool = make({
  name: "run_code",
  description: "Execute code in a temporary sandbox (Python or Node.js). Returns output or errors. Use when: calculating something, testing logic, processing data, running algorithms. Choose language based on task: python for data analysis, node for JS/TS logic.",
  inputSchema: z.object({
    code: z.string().describe("Code to execute"),
    language: z.enum(["python", "node"]).optional().describe("Runtime: python (default) or node"),
  }),
  outputSchema: z.string(),
  permission: "run_code",

  async execute(input, _ctx) {
    // C2: 代码执行经 code-runtime 缝（可替换 provider 迁移到远程沙箱）
    const result = await getCodeRuntime().run({
      code: input.code,
      language: input.language ?? "python",
      timeoutMs: 30000,
    })
    const output = (result.stdout || result.stderr).slice(0, 10000)
    if (result.exitCode !== 0) {
      return { success: false, error: (result.stderr || output || "(no output)").slice(0, 5000) }
    }
    return { success: true, output: output || "(no output)" }
  },
})

