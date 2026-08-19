import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { make } from "../../shared/tool"

async function globRecursive(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await globRecursive(fullPath, pattern))
    } else if (entry.isFile() && matchGlob(entry.name, pattern)) {
      results.push(fullPath)
    }
  }
  return results
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
  return regex.test(name)
}

export const globTool = make({
  name: "glob",
  description: "Find files by name pattern. Supports wildcards like **/*.ts, src/**/*.js. Use when: finding TypeScript/JavaScript files, locating config files, finding files by extension, exploring project structure. Do NOT use for: content search (use grep), reading file contents (use read_file). Prefer this tool over running 'find'/'ls' via bash.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. **/*.ts or src/**/*.py"),
    path: z.string().optional().describe("Search directory (default: workspace)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const searchPath = path.resolve(ctx.workspace, input.path || ".")
    const matches = await globRecursive(searchPath, path.basename(input.pattern))
    const root = path.resolve(searchPath)

    if (matches.length === 0) return { success: true, output: "No matching files" }

    const lines = matches.slice(0, 200).map((f) => {
      const rel = path.relative(root, f)
      return `📄 ${rel}`
    })

    let output = lines.join("\n")
    if (matches.length > 200) output += `\n... (${matches.length} total, showing 200)`
    return { success: true, output }
  },
})

