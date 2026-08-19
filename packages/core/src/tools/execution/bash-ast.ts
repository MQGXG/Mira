/**
 * bash-ast — 基于 tree-sitter 的 shell 命令静态解析（参考 opencode/mimo）
 *
 * 用 web-tree-sitter 解析 bash/powershell 命令 AST，提取文件操作命令
 * （rm/cp/mv/cat 等）的路径参数，检测是否触碰工作区外部目录。
 * WASM 不可用时自动回退 null（调用方降级到 token 匹配）。
 */

import path from "path"
import fs from "fs"

// 文件操作命令集合（bash + powershell + cmd 常见别名）
const FILE_COMMANDS = new Set([
  "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat", "cp", "mv", "rm",
  "get-content", "set-content", "add-content", "copy-item", "move-item",
  "remove-item", "new-item", "rename-item", "del", "erase", "dir", "rd", "ren", "md",
])

let parserPromise: Promise<{ parse: (command: string, ps: boolean) => import("web-tree-sitter").Tree | null } | null> | null = null

function resolveWasm(pkg: string, file: string): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath || ""
  const candidates = [
    // 开发/普通 node：项目根 node_modules
    path.join(process.cwd(), "node_modules", pkg, file),
    // 打包后 asar.unpacked（electron-builder asarUnpack **/*.wasm）
    path.join(resourcesPath, "app.asar.unpacked", "node_modules", pkg, file),
    path.join(resourcesPath, "app.asar.unpacked", pkg, file),
    // 源码相对路径（tsx 直接跑）
    path.join(__dirname, "..", "..", "..", "node_modules", pkg, file),
    path.join(__dirname, "..", "..", "..", "..", "node_modules", pkg, file),
    path.join(__dirname, "..", "..", "..", "..", "..", "node_modules", pkg, file),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return candidates[0]
}

async function loadParser(): Promise<{ parse: (command: string, ps: boolean) => import("web-tree-sitter").Tree | null } | null> {
  try {
    const { Parser, Language } = await import("web-tree-sitter")
    await Parser.init({
      locateFile: (file: string) => resolveWasm("web-tree-sitter", file),
    })
    const bashWasm = resolveWasm("tree-sitter-bash", "tree-sitter-bash.wasm")
    const psWasm = resolveWasm("tree-sitter-powershell", "tree-sitter-powershell.wasm")
    if (!fs.existsSync(bashWasm) || !fs.existsSync(psWasm)) return null
    const [bashLang, psLang] = await Promise.all([
      Language.load(bashWasm),
      Language.load(psWasm),
    ])
    const bashParser = new Parser()
    bashParser.setLanguage(bashLang)
    const psParser = new Parser()
    psParser.setLanguage(psLang)
    return {
      parse: (command: string, ps: boolean) => (ps ? psParser : bashParser).parse(command),
    }
  } catch {
    return null
  }
}

export function getBashParser(): Promise<{ parse: (command: string, ps: boolean) => import("web-tree-sitter").Tree | null } | null> {
  if (!parserPromise) parserPromise = loadParser()
  return parserPromise
}

interface NodeLike {
  type: string
  text: string
  childCount: number
  child(i: number): NodeLike | null
}

/** 递归遍历，收集文件命令触碰的外部目录（相对 cwd） */
function collectExternalDirs(node: NodeLike, cwd: string, dirs: Set<string>): void {
  if (node.type === "command" || node.type === "command_definition" || node.type === "redirected_statement") {
    // 提取命令名 + 参数
    let cmdName = ""
    const args: string[] = []
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (child.type === "command_name" && !cmdName) {
        cmdName = child.text.trim().toLowerCase()
      } else if (
        child.type === "command_argument" || child.type === "word" ||
        child.type === "string" || child.type === "raw_string" || child.type === "concatenation"
      ) {
        args.push(child.text.trim())
      }
    }
    if (cmdName && FILE_COMMANDS.has(cmdName)) {
      for (const arg of args) {
        const clean = arg.replace(/^["']|["']$/g, "").replace(/[;,&|]$/, "")
        if (!clean || clean.startsWith("-")) continue
        const abs = path.isAbsolute(clean) ? clean : path.resolve(cwd, clean)
        if (abs.startsWith(cwd)) continue
        dirs.add(path.dirname(abs))
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) collectExternalDirs(child, cwd, dirs)
  }
}

/**
 * 用 tree-sitter 提取命令触碰的外部目录。
 * 返回 null 表示 parser 不可用（调用方应回退 token 匹配）。
 */
export async function parseExternalDirs(
  command: string,
  cwd: string,
  ps: boolean,
): Promise<string[] | null> {
  const parser = await getBashParser()
  if (!parser) return null
  try {
    const tree = parser.parse(command, ps)
    if (!tree) return null
    const dirs = new Set<string>()
    collectExternalDirs(tree.rootNode, cwd, dirs)
    tree.delete?.()
    return [...dirs]
  } catch {
    return null
  }
}
