/**
 * LSP 代码上下文 — 自动注入代码智能到 Agent 上下文
 * 
 * 参考 OpenCode 的 LSP 集成模式（自动加载 + 上下文注入）
 * 不再需要 LLM 主动调用 lsp_definition/lsp_references 等工具
 */

import * as fs from "fs"
import * as path from "path"
import { lspManager } from "./manager"
import { getServerDefForFile } from "./server-defs"

export interface CodeIntel {
  symbols: string[]
  diagnostics: string[]
}

export class CodeContext {
  async getContextForFile(filePath: string, workspace?: string): Promise<CodeIntel> {
    try {
      const symbols = await this.getSymbols(filePath, workspace)
      return { symbols, diagnostics: [] }
    } catch {
      return { symbols: [], diagnostics: [] }
    }
  }

  async buildSystemPromptSuffix(workspace: string, currentFile?: string): Promise<string> {
    const parts: string[] = []

    try {
      const languages = this.detectLanguages(workspace)
      if (languages.length > 0) {
        parts.push(`Project languages: ${languages.join(", ")}`)
      }

      if (currentFile) {
        const intel = await this.getContextForFile(currentFile, workspace)
        if (intel.symbols.length > 0) {
          parts.push(`Current file symbols: ${intel.symbols.slice(0, 20).join(", ")}`)
        }
      }
    } catch {
      // 静默失败
    }

    return parts.length > 0 ? `\n[Code Context]\n${parts.join("\n")}` : ""
  }

  /** 通过 LSP documentSymbols 获取文件符号列表（LSP 未就绪时静默降级为空） */
  private async getSymbols(filePath: string, workspace?: string): Promise<string[]> {
    if (!workspace) return []

    // 仅处理受支持的文件类型，避免为无关文件启动 LSP
    const def = getServerDefForFile(filePath)
    if (!def) return []

    try {
      const symbols = await lspManager.getSymbols(workspace, filePath)
      const names: string[] = []
      const collect = (list: { name: string; children?: Array<{ name: string }> }[]): void => {
        for (const sym of list) {
          if (sym?.name) names.push(sym.name)
          if (sym.children?.length) collect(sym.children)
        }
      }
      collect(symbols)
      return names
    } catch {
      return []
    }
  }

  private detectLanguages(workspace: string): string[] {
    const existsSync = fs.existsSync
    const readdirSync = fs.readdirSync
    const join = path.join

    const indicators: Record<string, string[]> = {
      typescript: ["tsconfig.json", "*.ts", "*.tsx"],
      javascript: ["package.json", "*.js", "*.jsx"],
      python: ["requirements.txt", "setup.py", "*.py"],
      rust: ["Cargo.toml", "*.rs"],
      go: ["go.mod", "*.go"],
      java: ["pom.xml", "build.gradle", "*.java"],
    }

    try {
      if (!existsSync(join(workspace, "package.json"))) {
        try {
          const entries = readdirSync(workspace)
          for (const [lang, hints] of Object.entries(indicators)) {
            if (hints.some((h) => entries.some((e: string) => e.endsWith(h.replace("*", "")) || e === h))) {
              return [lang]
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return []
  }
}
