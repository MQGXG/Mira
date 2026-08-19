/**
 * 语言服务器定义 — 声明式描述支持的 LSP 服务器
 * 参考 Serena solidlsp/language_servers/*.py 的抽象，与进程管理解耦
 */

import * as fs from "fs"
import * as path from "path"

export interface LSPDependency {
  /** npm 包名（白名单，禁止拼接用户输入） */
  name: string
  /** 固定版本号（版本锁定，防止供应链漂移） */
  version: string
}

export interface LanguageServerDef {
  /** 服务器唯一标识（同时用于缓存目录名） */
  id: string
  /** 展示名 */
  displayName: string
  /** workspace 检测：判断项目是否适用该服务器 */
  detect(workspace: string): boolean
  /** 需要安装的 npm 依赖（按安装顺序） */
  dependencies: LSPDependency[]
  /** 依赖入口脚本（相对 node_modules 包目录），用于跨平台 node 启动（新版为 ESM .mjs） */
  entryScript: string
  /** 扩展名 → LSP languageId 映射 */
  languageIds: Record<string, string>
  /** 启动后是否需要等待项目索引进度（如 tsserver） */
  waitsForIndexing: boolean
}

const TYPESCRIPT_VERSION = "5.9.3"
const TYPESCRIPT_LANGUAGE_SERVER_VERSION = "5.1.3"

const typescriptDef: LanguageServerDef = {
  id: "typescript",
  displayName: "TypeScript",
  detect: (workspace: string): boolean => {
    const hasTsConfig = fileExists(path.join(workspace, "tsconfig.json"))
    const hasPackageJson = fileExists(path.join(workspace, "package.json"))
    return hasTsConfig || hasPackageJson
  },
  dependencies: [
    { name: "typescript", version: TYPESCRIPT_VERSION },
    { name: "typescript-language-server", version: TYPESCRIPT_LANGUAGE_SERVER_VERSION },
  ],
  entryScript: "typescript-language-server/lib/cli.mjs",
  languageIds: {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mts: "typescript",
    mjs: "javascript",
  },
  waitsForIndexing: true,
}

/** 内置语言服务器注册表 */
export const LANGUAGE_SERVERS: LanguageServerDef[] = [typescriptDef]

/** 检测 workspace 匹配的语言服务器定义，未匹配返回 null */
export function detectLanguageServer(workspace: string): LanguageServerDef | null {
  for (const def of LANGUAGE_SERVERS) {
    if (def.detect(workspace)) return def
  }
  return null
}

/** 根据扩展名获取语言服务器定义 */
export function getServerDefForFile(filePath: string): LanguageServerDef | null {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  for (const def of LANGUAGE_SERVERS) {
    if (def.languageIds[ext]) return def
  }
  return null
}

/** 获取文件对应的 LSP languageId（未匹配返回 plaintext） */
export function getLanguageId(def: LanguageServerDef, filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return def.languageIds[ext] || "plaintext"
}

function fileExists(filepath: string): boolean {
  try {
    return fs.existsSync(filepath)
  } catch {
    return false
  }
}
