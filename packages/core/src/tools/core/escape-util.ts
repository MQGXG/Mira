/**
 * 模型输出反转义工具
 *
 * LLM 有时会在输出 oldString/newString/patch 时插入特殊标记或转义，
 * 导致精确匹配失败。此工具做预处理还原。
 */

/** 常见模型标记映射 */
const MODEL_MARKERS: [RegExp, string][] = [
  [/<fnr>/g, ""],
  [/<\/?function_results?>/gi, ""],
  [/<\/?function_Result>/g, ""],
  [/<\/?result>/gi, ""],
  [/<\/?tool_result>/gi, ""],
  [/\[TOOL_RESULT\]/gi, ""],
  [new RegExp("\\[/\\*\\s*TOOL_RESULT\\s*\\*\\/\\]", "gi"), ""],
]

/** 反转义 LLM 输出中的特殊字符 */
export function unescapeModelOutput(text: string): string {
  let result = text

  // 去除模型插入的特殊标记
  for (const [pattern, replacement] of MODEL_MARKERS) {
    result = result.replace(pattern, replacement)
  }

  // 反转义 HTML 实体
  result = result
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x60;/g, "`")

  // 反转义 JS 转义序列（某些模型会额外转义）
  result = result
    .replace(/\\(['"`\\])/g, "$1")    // \' \" \` \\
    .replace(/\\n/g, "\n")              // 转义的换行
    .replace(/\\t/g, "\t")              // 转义的制表符
    .replace(/\\r/g, "\r")             // 转义的回车
    .replace(/\\([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))

  // 去除多余的包裹缩进（每个行首多出的空格）
  const lines = result.split("\n")
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length > 0) {
    const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)?.[1]?.length || 0))
    if (minIndent > 0) {
      result = lines.map(l => l.slice(minIndent)).join("\n")
    }
  }

  return result.trim()
}

/** 标准化编辑输入：对 oldString 和 newString 同时做反转义 */
export function normalizeEditInput(oldString: string, newString: string): { oldString: string; newString: string } {
  return {
    oldString: unescapeModelOutput(oldString),
    newString: unescapeModelOutput(newString),
  }
}
