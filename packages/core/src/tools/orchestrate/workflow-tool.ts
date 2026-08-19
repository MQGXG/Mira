import { z } from "zod"
import { make } from "../../shared/tool"
import { WorkflowEngine, type WorkflowDefinition } from "../../workflow/index"

const workflowEngine = new WorkflowEngine()

export const workflowRunTool = make({
  name: "workflow_run",
  description: "Execute a multi-step workflow with sequential/parallel steps. Supports agent steps (LLM prompts), bash steps (shell commands), parallel execution, and pipeline orchestration. Use for complex multi-step tasks that require structured execution.",
  inputSchema: z.object({
    workflow: z.object({
      name: z.string().describe("Workflow name"),
      description: z.string().describe("Workflow purpose"),
      steps: z.array(z.object({
        id: z.string(),
        type: z.enum(["agent", "bash", "parallel", "pipeline", "transform"]),
        name: z.string(),
        description: z.string().optional(),
        prompt: z.string().optional().describe("For agent steps: the task prompt"),
        command: z.string().optional().describe("For bash steps: shell command"),
        steps: z.array(z.any()).optional().describe("Nested steps for parallel/pipeline"),
        transform: z.string().optional().describe("For transform steps: builtin function name"),
        timeout: z.number().optional(),
      })),
    }).describe("Workflow definition with steps to execute"),
  }),
  outputSchema: z.string(),
  permission: "workflow",

  async execute(input, ctx) {
    try {
      const result = await workflowEngine.execute(input.workflow, {
        signal: ctx.signal,
      })

      const summary = result.results.map((r) => {
        const children = r.children
          ? r.children.map((c) => `    ${c.status === "success" ? "✓" : "✗"} ${c.stepName}: ${c.output.slice(0, 100)}`).join("\n")
          : ""
        return `${r.status === "success" ? "✓" : "✗"} ${r.stepName} (${r.elapsedMs}ms)\n${children ? children + "\n" : ""}  ${r.output.slice(0, 300)}`
      }).join("\n\n")

      return { success: true, output: `Workflow "${input.workflow.name}" completed in ${result.elapsedMs}ms\n\n${summary}` }
    } catch (err) {
      return { success: false, error: `Workflow execution failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

