/**
 * gen-catalog — 生成工具目录（单一来源，对齐 dsh gen-tool-catalog）
 *
 * 静态扫描工具定义文件，提取 make({...}) 中的 name/description 生成目录，
 * 避免运行时注册（依赖 MCP/LLM 等外部包，解析复杂）。
 * 加 --check 可校验目录与源码是否漂移。
 *
 * 运行：
 *   pnpm exec tsx scripts/gen-catalog.ts          # 生成
 *   pnpm exec tsx scripts/gen-catalog.ts --check  # 校验
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { join, relative } from "path"

const ROOT = process.cwd()
const OUT_PATH = join(ROOT, "packages/core/src/assets/tool-catalog.json")
const TOOLS_DIR = join(ROOT, "packages/core/src/tools")
const CHECK = process.argv.includes("--check")

interface CatalogEntry {
  name: string
  description: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  if (!statSync(dir, { throwIfNoEntry: false })) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full)
  }
  return out
}

/** 从 make({...}) 块中提取 name + description */
function extractToolDef(content: string, file: string): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  const blockRe = /make\(\{[\s\S]*?\}\)(?:\s*as\s+const)?/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[0]
    const name = block.match(/name:\s*"([^"]+)"/)?.[1]
    const description = block.match(/description:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
    if (name && description) entries.push({ name, description })
  }
  return entries
}

function buildCatalog(): { version: number; updatedAt: string; tools: CatalogEntry[] } {
  const tools: CatalogEntry[] = []
  for (const file of walk(TOOLS_DIR)) {
    const content = readFileSync(file, "utf8")
    for (const entry of extractToolDef(content, file)) {
      if (!tools.some((t) => t.name === entry.name)) tools.push(entry)
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name))
  return { version: 1, updatedAt: new Date().toISOString().slice(0, 10), tools }
}

const catalog = buildCatalog()

if (CHECK) {
  if (!existsSync(OUT_PATH)) {
    console.error(`❌ ${relative(ROOT, OUT_PATH)} 不存在，请先运行 pnpm exec tsx scripts/gen-catalog.ts`)
    process.exit(1)
  }
  const current = JSON.parse(readFileSync(OUT_PATH, "utf-8")) as { tools: CatalogEntry[] }
  const currentNames = new Set(current.tools.map((t) => t.name))
  const newNames = catalog.tools.map((t) => t.name)
  const missing = newNames.filter((n) => !currentNames.has(n))
  const stale = current.tools.filter((t) => !newNames.includes(t.name))
  if (missing.length > 0 || stale.length > 0) {
    console.error("❌ 工具目录漂移：")
    if (missing.length) console.error(`   catalog 缺失: ${missing.join(", ")}`)
    if (stale.length) console.error(`   catalog 多余: ${stale.map((t) => t.name).join(", ")}`)
    process.exit(1)
  }
  console.log(`✅ 工具目录一致（${catalog.tools.length} 个工具）`)
} else {
  writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf-8")
  console.log(`✅ 已生成 ${relative(ROOT, OUT_PATH)}（${catalog.tools.length} 个工具）`)
}
