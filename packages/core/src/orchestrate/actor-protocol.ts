/**
 * 标准化 Actor 返回协议
 * 子 Agent 必须按此格式输出结果，以便孵化者统一解析
 */

export const RETURN_FORMAT_INSTRUCTION = `
当你完成任务时，请使用以下格式作为你回复的最后一部分：

**Status**: success | partial | failed | blocked
**Summary**: <一句话概括>

<实际交付内容>

**Files touched**: <文件路径列表，逗号分隔>
**Findings worth promoting**: <值得记住的重要发现>
`;

export interface ActorResult {
  status: "success" | "partial" | "failed" | "blocked";
  summary: string;
  body: string;
  files: string[];
  findings: string[];
}

/** 从子 Agent 的回复中解析标准化结果 */
export function parseActorResult(text: string): ActorResult | null {
  const statusMatch = text.match(/\*\*Status\*\*:\s*(success|partial|failed|blocked)/i);
  const summaryMatch = text.match(/\*\*Summary\*\*:\s*(.+?)(?:\n|$)/i);
  const filesMatch = text.match(/\*\*Files touched\*\*:\s*(.+?)(?:\n|$)/i);
  const findingsMatch = text.match(/\*\*Findings worth promoting\*\*:\s*([\s\S]*?)(?:\n\n|\*{2}|$)/i);

  const status = statusMatch?.[1]?.toLowerCase() as ActorResult["status"] || "failed";
  const summary = summaryMatch?.[1]?.trim() || "";

  // body：Status 和 Summary 之后的文本，去掉尾部协议行
  let body = text;
  const statusIdx = text.indexOf("**Status**");
  if (statusIdx >= 0) {
    body = text.slice(statusIdx);
    // 去掉 **Findings** 及之后的内容
    const findingsIdx = body.indexOf("**Findings worth promoting**");
    if (findingsIdx >= 0) body = body.slice(0, findingsIdx);
    // 去掉 **Files touched** 行
    const filesIdx = body.indexOf("**Files touched**");
    if (filesIdx >= 0) body = body.slice(0, filesIdx);
    // 去掉 Status/Summary 头
    const bodyStart = body.indexOf("\n\n", body.indexOf("**Summary**") > 0 ? body.indexOf("**Summary**") : 0);
    if (bodyStart >= 0) body = body.slice(bodyStart + 2).trim();
    else body = "";
  }

  const files = filesMatch
    ? filesMatch[1].split(",").map((f: string) => f.trim()).filter(Boolean)
    : [];

  const findings = findingsMatch
    ? findingsMatch[1].split("-").map((f: string) => f.trim()).filter(Boolean)
    : [];

  return { status, summary, body, files, findings };
}

/** 注入返回协议到子 Agent 的 prompt 末尾 */
export function injectReturnFormat(prompt: string): string {
  if (prompt.includes("**Status**")) return prompt;
  return `${prompt}\n\n${RETURN_FORMAT_INSTRUCTION}`;
}
