import * as path from "path"
import { z } from "zod"
import { make } from "../../shared/tool"
import { getFs } from "../../capability/fs"

export const listFilesTool = make({
  name: "list_files",
  description: "List directory contents. Shows files and subdirectories with sizes.",
  inputSchema: z.object({
    path: z.string().optional().default(".").describe("Directory path (default: workspace root)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const resolved = path.resolve(ctx.workspace, input.path || ".")
    // 经 capability fs seam：换 Provider 后文件列表跟随（换 Provider 换产品）
    const stat = await getFs().stat(resolved)
    if (!stat || !stat.isDirectory) return { success: false, error: `Not a directory: ${input.path}` }

    const entries = await getFs().readdir(resolved)
    const dirs: string[] = []
    const files: string[] = []

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory) dirs.push(`📁 ${entry.name}/`)
      else {
        try {
          const fileStat = await getFs().stat(path.join(resolved, entry.name))
          files.push(`📄 ${entry.name} (${fileStat?.size ?? 0} bytes)`)
        } catch {
          files.push(`📄 ${entry.name}`)
        }
      }
    }

    const output = [...dirs, ...files]
    return {
      success: true,
      output: output.length > 0 ? output.join("\n") : "(empty directory)",
    }
  },
})

