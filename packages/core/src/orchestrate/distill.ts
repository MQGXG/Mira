import * as fs from "fs"
import { join } from "path"
import { createLLMClient, type LLMMessage } from "../llm/client"
import { logError } from "../system/logger"
import type { DistillResult, DistillWorkflow, LLMConfig } from "./dream-types"

const DISTILL_SYSTEM_PROMPT = `You are a workflow discovery agent. Your task is to analyze recent work patterns and identify repeated manual workflows that could be automated.

Look for:
1. Repeated sequences of tool calls
2. Similar tasks performed multiple times
3. Common development patterns
4. Multi-step workflows that follow a template

For each discovered workflow, provide:
- Name and description
- Confidence level (0-1)
- Type (skill/subagent/command)
- Steps involved
- Example usage

Respond in JSON format:
{
  "workflows": [
    {
      "name": "...",
      "description": "...",
      "confidence": 0.8,
      "type": "skill",
      "steps": ["step1", "step2"],
      "examples": ["example1"]
    }
  ],
  "summary": "Brief summary"
}`

function parseDistillResponse(text: string): { workflows: DistillWorkflow[]; summary: string } {
  try {
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim()
    const parsed = JSON.parse(cleaned) as {
      workflows?: Array<{ name?: string; description?: string; confidence?: number; type?: string; steps?: string[]; examples?: string[] }>
      summary?: string
    }
    return {
      workflows: (parsed.workflows || []).map((w, i) => ({
        id: `wf_${Date.now().toString(36)}_${i}`,
        name: w.name || "",
        description: w.description || "",
        confidence: w.confidence || 0,
        type: (w.type || "skill") as DistillWorkflow["type"],
        steps: w.steps || [],
        examples: w.examples || [],
      })),
      summary: parsed.summary || "",
    }
  } catch {
    return { workflows: [], summary: "Failed to parse distill response" }
  }
}

function generateSkillFile(workflow: DistillWorkflow): void {
  const skillDir = join(process.cwd(), ".mira", "skills")
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })

  const filename = `${workflow.name.replace(/\s+/g, "-").toLowerCase()}.skill.md`
  const content = [
    `# ${workflow.name}`,
    "",
    `> ${workflow.description}`,
    "",
    "## Steps",
    ...workflow.steps.map(s => `- ${s}`),
    "",
    "## Examples",
    ...workflow.examples.map(e => `- ${e}`),
    "",
  ].join("\n")

  fs.writeFileSync(join(skillDir, filename), content, "utf-8")
}

export async function runDistill(
  conversationHistory: LLMMessage[],
  config: LLMConfig,
  skillDir: string,
): Promise<DistillResult> {
  const result: DistillResult = {
    timestamp: new Date().toISOString(),
    workflowsFound: [],
    summary: "",
  }

  try {
    const messages: LLMMessage[] = [
      { role: "system", content: DISTILL_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Conversation history:\n${formatConversation(conversationHistory)}\n\nIdentify repeated workflows that could be automated.`,
      },
    ]

    const client = createLLMClient(config)
    let responseText = ""
    for await (const event of client.stream({ messages })) {
      if (event.type === "delta") responseText += event.delta
    }

    const parsed = parseDistillResponse(responseText)
    result.workflowsFound = parsed.workflows
    result.summary = parsed.summary || "Distill completed"

    for (const workflow of result.workflowsFound) {
      if (workflow.confidence >= 0.7) generateSkillFile(workflow)
    }
  } catch (err) {
    logError("[Distill] Failed", err)
    result.summary = `Distill failed: ${String(err)}`
  }

  return result
}

function formatConversation(messages: LLMMessage[]): string {
  return messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `[${m.role}]\n${typeof m.content === "string" ? m.content.slice(0, 500) : ""}`)
    .join("\n\n")
}
