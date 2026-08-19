/**
 * officecli_* Consumer 工具（office 能力缝）
 *
 * 读类（permission: read）：inspect / get / query / issues / validate
 * 写类（permission: edit）：edit（batch 批量）/ merge（模板合并）
 * 无 officecli 时由条件注册隐藏；执行时 fail-closed（requireOffice）。
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { requireOffice, resolveOfficePath, runOfficeCli, formatJsonOutput } from "./office-cli"

// ── 读类工具 ─────────────────────────────────────────────

/** 文档结构总览：view text + view stats */
export const officecliInspectTool = make({
  name: "officecli_inspect",
  description:
    "Inspect an Office document (.docx/.xlsx/.pptx): extract readable content (xlsx as A1=value cells) plus structure stats. Use when: user asks to read/analyze a Word/Excel/PPT document, extract its content, or check its structure. Requires officecli (bundled).",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    const [text, stats] = await Promise.all([
      req.office.run(["view", file, "text", "--json"]),
      req.office.run(["view", file, "stats", "--json"]),
    ])
    if (text.timedOut || stats.timedOut) return { success: false, error: "officecli 命令超时" }
    if (text.exitCode !== 0 && stats.exitCode !== 0) {
      return { success: false, error: (text.stderr || text.stdout || "(no output)").slice(0, 5000) }
    }
    const parts: string[] = []
    if (text.exitCode === 0) parts.push("## 内容\n" + formatJsonOutput(text))
    if (stats.exitCode === 0) parts.push("## 统计\n" + formatJsonOutput(stats))
    return { success: true, output: parts.join("\n\n").slice(0, 10000), metadata: { code: "ok" } }
  },
})

/** 按 DOM 路径取节点 */
export const officecliGetTool = make({
  name: "officecli_get",
  description:
    "Get a document node by DOM path (e.g. /body/p[1], /Slide1) from an Office document. Use when: you need a specific paragraph/table/slide/cell structure. Requires officecli.",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
    nodePath: z.string().optional().default("/").describe("DOM path to read (default / = whole document)"),
    depth: z.number().optional().default(2).describe("Depth of child nodes to include"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    const args = ["get", file, input.nodePath ?? "/", "--depth", String(input.depth), "--json"]
    const r = await req.office.run(args)
    if (r.timedOut) return { success: false, error: "officecli 命令超时", metadata: { code: "officecli_timeout" } }
    if (r.exitCode !== 0) {
      return { success: false, error: (r.stderr || r.stdout || "(no output)").slice(0, 5000), metadata: { exitCode: r.exitCode, code: "officecli_command_failed" } }
    }
    return { success: true, output: formatJsonOutput(r), metadata: { exitCode: r.exitCode } }
  },
})

/** CSS-like 选择器查询 */
export const officecliQueryTool = make({
  name: "officecli_query",
  description:
    "Query elements in an Office document with CSS-like selectors (e.g. 'paragraph[style=Normal] > run[font!=Arial]', '*' lists all blocks). Use when: scanning a document's elements by style/type. Requires officecli.",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
    selector: z.string().describe("CSS-like selector (e.g. 'paragraph, table' or '*')"),
    find: z.string().optional().describe("Filter results to elements containing this text (case-insensitive)"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    const args = ["query", file, input.selector, "--json"]
    if (input.find) args.push("--find", input.find)
    return runOfficeCli(req.office, args)
  },
})

/** 质量问题清单 */
export const officecliIssuesTool = make({
  name: "officecli_issues",
  description:
    "List quality issues in an Office document (broken formulas, stale fields, missing references, low contrast). Use after editing to self-check. Requires officecli.",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
    type: z
      .enum(["format", "content", "structure"])
      .optional()
      .describe("Issue type filter: format / content / structure"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    const args = ["view", file, "issues", "--json"]
    if (input.type) args.push("--type", input.type)
    return runOfficeCli(req.office, args)
  },
})

/** OpenXML schema 校验 */
export const officecliValidateTool = make({
  name: "officecli_validate",
  description:
    "Validate an Office document against the OpenXML schema. Use when: confirming a generated/edited document is structurally valid. Requires officecli.",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    return runOfficeCli(req.office, ["validate", file, "--json"])
  },
})

// ── 写类工具 ─────────────────────────────────────────────

/** 批量编辑 */
export const officecliEditTool = make({
  name: "officecli_edit",
  description:
    "Edit an Office document with a batch of commands (add/set/remove/move/swap) in one open/save cycle. Each item: {command, parent?, path?, type?, props?, to?, after?, before?, path2?}. Example: [{command:'add',parent:'/body',type:'paragraph',props:{text:'Hi'}},{command:'set',path:'/body/p[1]',props:{bold:'true'}}]. Requires officecli.",
  inputSchema: z.object({
    path: z.string().describe("Office document path (absolute or relative to workspace)"),
    commands: z
      .array(z.record(z.string(), z.unknown()))
      .describe("Batch of edit commands (JSON array, each item is an object with a 'command' verb)"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const file = resolveOfficePath(input.path, ctx.workspace)
    const commandsJson = JSON.stringify(input.commands)
    return runOfficeCli(req.office, ["batch", file, "--commands", commandsJson])
  },
})

/** 模板合并 */
export const officecliMergeTool = make({
  name: "officecli_merge",
  description:
    "Merge an Office template with JSON data, replacing {{key}} placeholders, producing a new file. Use when: batch-filling a report/letter from data. Requires officecli.",
  inputSchema: z.object({
    template: z.string().describe("Template file path (.docx/.xlsx/.pptx with {{key}} placeholders)"),
    output: z.string().describe("Output file path"),
    data: z.record(z.string(), z.unknown()).describe("JSON data to fill into {{key}} placeholders"),
    force: z.boolean().optional().default(false).describe("Overwrite an existing output file"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  async execute(input, ctx) {
    const req = requireOffice()
    if (req.error) return req.error
    const template = resolveOfficePath(input.template, ctx.workspace)
    const output = resolveOfficePath(input.output, ctx.workspace)
    const args = ["merge", template, output, "--data", JSON.stringify(input.data)]
    if (input.force) args.push("--force")
    return runOfficeCli(req.office, args)
  },
})