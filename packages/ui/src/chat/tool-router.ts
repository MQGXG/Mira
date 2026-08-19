/** 前端工具路由 — 基于关键词和语义模式的智能工具匹配 */
export function routeToolMessage(input: string, tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): { name: string; args: Record<string, unknown> } | null {
  const lower = input.toLowerCase().trim();
  const matches = new Map<string, { name: string; args: Record<string, unknown>; score: number }>();

  for (const t of tools) {
    if (lower.startsWith("read ") || lower.startsWith("open ") || lower.startsWith("show ") || lower.startsWith("cat ")) {
      if (t.name === "read_file") {
        matches.set("read_file", { name: "read_file", args: { path: lower.replace(/^(read|open|show|cat)\s+/i, "").trim() }, score: 100 });
      }
    }

    if (lower.startsWith("search ") || lower.startsWith("find ") || lower.startsWith("查找") || lower.startsWith("搜索") || lower.startsWith("谷歌") || lower.startsWith("google ")) {
      if (t.name === "web_search") {
        matches.set("web_search", { name: "web_search", args: { query: lower.replace(/^(search|find|查找|谷歌|google|搜索)\s+/i, "").trim() }, score: 95 });
      }
    }

    if ((lower.startsWith("ls ") || lower.startsWith("list ") || lower.startsWith("dir ") || lower === "ls" || lower === "list" || lower === "dir" || lower.startsWith("列出") || lower.startsWith("查看目录"))) {
      if (t.name === "list_files") {
        const path = lower.replace(/^(ls|list|dir|列出|查看目录)\s*/i, "").trim();
        matches.set("list_files", { name: "list_files", args: path ? { path } : {}, score: 90 });
      }
    }

    if ((lower.startsWith("grep") && lower.length > 4) || lower.startsWith("查找内容") || lower.startsWith("搜索内容") || /grep\s/.test(lower)) {
      if (t.name === "grep") {
        const pattern = lower.replace(/^grep\s*/i, "").trim().split(/\s+/)[0];
        matches.set("grep", { name: "grep", args: { pattern }, score: 85 });
      }
    }

    if (lower.startsWith("glob ") || lower.startsWith("find ") || lower.startsWith("查找文件") || lower.startsWith("匹配文件")) {
      if (t.name === "glob") {
        const pattern = lower.replace(/^(glob|find|查找文件|匹配文件)\s*/i, "").trim();
        matches.set("glob", { name: "glob", args: { pattern: pattern || "**/*" }, score: 85 });
      }
    }

    if (lower.startsWith("run ") || lower.startsWith("运行") || lower.startsWith("执行")) {
      if (t.name === "run_code") {
        matches.set("run_code", { name: "run_code", args: { code: input.replace(/^(run|运行|执行)\s+/i, "").trim() }, score: 80 });
      }
    }
    if (lower.startsWith("bash ") || lower.startsWith("shell ") || lower.startsWith("终端") || lower.startsWith("命令 ")) {
      if (t.name === "bash") {
        matches.set("bash", { name: "bash", args: { command: input.replace(/^(bash|shell|终端|命令)\s*/i, "").trim() }, score: 80 });
      }
    }

    if (lower.startsWith("edit ") || lower.startsWith("修改") || lower.startsWith("替换 ") || lower.startsWith("replace ")) {
      if (t.name === "edit_file") {
        matches.set("edit_file", { name: "edit_file", args: { path: lower.replace(/^(edit|修改|替换|replace)\s+/i, "").trim() }, score: 75 });
      }
    }
    if (lower.startsWith("write ") || lower.startsWith("写入") || lower.startsWith("创建 ") || lower.startsWith("create ")) {
      if (t.name === "write_file") {
        matches.set("write_file", { name: "write_file", args: { path: lower.replace(/^(write|创建|写入|create)\s+/i, "").trim() }, score: 75 });
      }
    }
  }

  if (matches.size === 0) return null;
  return Array.from(matches.values()).sort((a, b) => b.score - a.score)[0];
}
