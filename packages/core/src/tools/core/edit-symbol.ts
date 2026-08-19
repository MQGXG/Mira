export function extractSymbolName(text: string): string | null {
  const patterns = [
    /(?:function|class|interface|type|enum)\s+(\w+)/,
    /(?:const|let|var|import)\s+(\w+)/,
    /(\w+)\s*[=:(]/,
    /(?:def|class)\s+(\w+)/,
    /(?:func|type|struct)\s+(\w+)/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1]
  }
  const words = text.match(/\b([a-zA-Z_$][\w$]*)\b/g)
  if (words) {
    const keywords = new Set(["if", "else", "for", "while", "return", "const", "let", "var",
      "function", "class", "import", "export", "from", "async", "await", "new", "this",
      "true", "false", "null", "undefined", "try", "catch", "throw", "switch", "case",
      "default", "break", "continue", "type", "interface", "enum"])
    for (const word of words) {
      if (!keywords.has(word) && word.length > 2) return word
    }
  }
  return null
}

export function findSymbolInTree(symbols: any, name: string): any {
  if (!Array.isArray(symbols)) return null
  for (const sym of symbols) {
    if (sym.name === name) return sym
    if (sym.children) {
      const found = findSymbolInTree(sym.children, name)
      if (found) return found
    }
  }
  return null
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    json: "json", md: "markdown", css: "css", scss: "scss", html: "html",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    swift: "swift", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
    sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql", graphql: "graphql", prisma: "prisma",
  }
  return langMap[ext || ""] || "plaintext"
}
