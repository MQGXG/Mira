import * as path from "path"
import { Effect } from "effect"
import * as ToolEffect from "../../shared/tool-effect"
import { getFs } from "../../capability/fs"

export const readFileTool = ToolEffect.define(
  "read_file",
  Effect.succeed({
    description: "Read file contents. Supports text files with auto-encoding detection. Relative paths resolve from workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to workspace)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["path"],
    },
    permission: "read",
    async execute(input, ctx) {
      const resolved = path.resolve(ctx.workspace, input.path as string)
      if (!resolved.startsWith(ctx.workspace)) {
        return { success: false, error: `Path escapes workspace: ${input.path}` }
      }
      // 经 capability fs seam：换 Provider 后读取跟随（换 Provider 换产品）
      const stat = await getFs().stat(resolved)
      if (!stat || !stat.isFile) return { success: false, error: `Not a file: ${input.path}` }

      const buffer = await getFs().readFile(resolved)
      const isBinary = buffer.includes(0)
      if (isBinary) {
        const ext = path.extname(resolved).toLowerCase()
        const binaryHints: Record<string, string> = {
          ".docx": "Word 文档（.docx）",
          ".pdf": "PDF 文件",
          ".xlsx": "Excel 文件",
          ".png": "图片文件",
          ".jpg": "图片文件",
          ".exe": "可执行文件",
          ".zip": "ZIP 压缩包",
          ".dll": "动态链接库",
        }
        const hint = binaryHints[ext] || `二进制文件 (${ext})`
        return { success: true, output: `${resolved} (${stat.size} bytes)\n${"─".repeat(40)}\n[二进制文件] ${hint}` }
      }

      let content = buffer.toString("utf-8")
      const limit = input.limit as number | undefined
      if (limit && limit > 0) {
        const lines = content.split("\n")
        content = lines.slice(0, limit).join("\n")
        if (lines.length > limit) content += `\n... (${lines.length} total, showing ${limit})`
      }
      const maxChars = 50000
      if (content.length > maxChars) content = content.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`
      return {
        success: true,
        output: `${resolved} (${stat.size} bytes)\n${"-".repeat(40)}\n${content}`,
      }
    },
  }),
)

