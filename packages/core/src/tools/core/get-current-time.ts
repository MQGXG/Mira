/**
 * get_current_time 工具 — 轻量即时时间查询（无进程、无网络）
 *
 * 解决"问现在几点还要调 bash date"的慢问题：
 * - 无进程启动、无网络请求，<1ms 返回
 * - 供 LLM 在用户问时间/日期时快速获取，避免 ReAct 中额外 shell 往返
 */

import { z } from "zod"
import { make } from "../../shared/tool"

export const getCurrentTimeTool = make({
  name: "get_current_time",
  description: "Get the current date and time, including timezone. Use this when the user asks what time it is, today's date, or any time-related question. Returns instantly without running any shell command.",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  isReadOnly: true,
  execute() {
    const now = new Date()
    const offsetMinutes = -now.getTimezoneOffset()
    const offsetHours = offsetMinutes / 60
    const sign = offsetMinutes >= 0 ? "+" : "-"
    const local = now.toLocaleString("zh-CN", { hour12: false, timeZoneName: "short" })
    return Promise.resolve({
      success: true,
      output: `Local time: ${local}\nISO 8601: ${now.toISOString()}\nTimezone offset: ${sign}${Math.abs(offsetHours)}h (UTC${sign}${Math.abs(offsetMinutes)}min)`,
    })
  },
})
