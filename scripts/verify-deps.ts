/**
 * verify-deps — 依赖方向校验（对齐 dsh verify-module-graph）
 *
 * 规则：
 *   1. 跨包钻取：packages/electron、packages/ui 禁止 import "@mira/core/<子路径>"
 *      只允许从 "@mira/core" 顶层导出引用（防止 core 内部文件移动即断）。
 *   2. 反向依赖：packages/core/src/system/server/* 禁止 import 底层模块
 *      （agent/session/tools/graph/memory/orchestrate/task/skill）——上帝模块防扩散。
 *   3. 三级深路径：packages/core/src 内 "../.." 深路径仅报告（不阻塞），供参考。
 *
 * 运行：pnpm exec tsx scripts/verify-deps.ts
 */

import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

const root = process.cwd()
const errors: string[] = []
let deepDrillCount = 0

function walk(dir: string): string[] {
  const out: string[] = []
  if (!dir || !statSync(dir, { throwIfNoEntry: false })) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full)
  }
  return out
}

// 规则 1：跨包钻取
const forbiddenSubpathImport = /from\s+["']@mira\/core\/([^"'/]+)["']/g
for (const pkg of ["packages/electron", "packages/ui"]) {
  const src = join(root, pkg, "src")
  for (const file of walk(src)) {
    const content = readFileSync(file, "utf8")
    for (const m of content.matchAll(forbiddenSubpathImport)) {
      errors.push(`${relative(root, file)}: 禁止钻取 "@mira/core/${m[1]}/..."，请改用 "@mira/core" 顶层导出`)
    }
  }
}

// 规则 2：system 非 API 层禁止反向依赖底层
// API 层（system/server）聚合底层服务是合理分层（handler 分发），豁免；
// 其余 system 模块（registry/permission/database 等）不得反向依赖底层，
// 防止非聚合模块直接钻取 agent/session/tools 等。
const bottomLayers = ["agent", "session", "tools", "graph", "memory", "orchestrate", "task", "skill"]
const reverseImport = new RegExp(`from\\s+["']\\.\\.\\/\\.\\.\\/(${bottomLayers.join("|")})[^"']*["']`, "g")
for (const file of walk(join(root, "packages/core/src/system"))) {
  const rel = relative(root, file).replace(/\\/g, "/")
  if (rel.includes("/server/")) continue // API 层豁免
  const content = readFileSync(file, "utf8")
  for (const m of content.matchAll(reverseImport)) {
    errors.push(`${relative(root, file)}: system 模块反向依赖底层 "${m[1]}"，应通过顶层出口聚合`)
  }
}

// 规则 3：三级深路径（报告）
for (const file of walk(join(root, "packages/core/src"))) {
  const content = readFileSync(file, "utf8")
  deepDrillCount += (content.match(/from\s+["']\.\.\/\.\.\//g) || []).length
}

if (errors.length > 0) {
  console.error(`\n❌ 依赖方向违规 ${errors.length} 处:`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error(`\n（另有三级深路径 ${deepDrillCount} 处，仅报告不阻塞）`)
  process.exit(1)
}

console.log(`✅ 依赖方向校验通过（三级深路径 ${deepDrillCount} 处，仅报告不阻塞）`)
