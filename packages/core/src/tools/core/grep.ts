import { execFile } from "child_process"
import { promisify } from "util"
import * as path from "path"
import { z } from "zod"
import { make } from "../../shared/tool"

const execFileAsync = promisify(execFile)

export const grepTool = make({
  name: "grep",
  description: "Search for text patterns in files using regex. Uses ripgrep for fast search. Use when: finding where a function is used, searching for TODO/FIXME comments, locating specific code patterns, finding variable definitions. Do NOT use for: searching the web (use web_search), searching conversation memory (use memory_search). Prefer this tool over running 'grep'/'rg' via bash.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    include: z.string().optional().describe("File glob pattern, e.g. *.ts"),
    path: z.string().optional().describe("Search directory (default: workspace)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const searchPath = path.resolve(ctx.workspace, input.path || ".")

    try {
      const args = ["-n", "--no-heading", input.pattern, searchPath]
      if (input.include) args.splice(1, 0, "-g", input.include)

      const { stdout, stderr } = await execFileAsync("rg", args, { timeout: 30000, maxBuffer: 1024 * 1024 })

      if (stdout) return { success: true, output: stdout.slice(0, 50000) }
      return { success: true, output: "No matches found" }
    } catch (e: any) {
      if (e.code === 1) return { success: true, output: "No matches found" } // rg exit code 1 = no match
      if (e.code === "ENOENT") {
        // rg not available, use fallback
        try {
          const { stdout } = await execFileAsync("findstr", ["/s", "/n", input.pattern, `${searchPath}\\*`], {
            timeout: 30000,
            shell: true,
          })
          return { success: true, output: stdout.slice(0, 50000) || "No matches found" }
        } catch {
          return { success: false, error: "No search tool available (install ripgrep)" }
        }
      }
      return { success: false, error: `Search failed: ${e.message}` }
    }
  },
})

