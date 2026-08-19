/**
 * 工具配对平衡 — 参考 DeepSeek Harness compaction/tool-pairing.ts
 *
 * 压缩改变消息序列的切口位置，安全切口必须位于"工具平衡"边界：
 * 即切口两侧不能有未应答的 tool-call（assistant 的 tool-call 必须与其
 * tool-result 配对）。用于防止压缩切断 tool-call/result 对导致孤立 tool 消息。
 */

/**
 * 工具配对平衡 — 参考 DeepSeek Harness compaction/tool-pairing.ts
 *
 * 压缩改变消息序列的切口位置，安全切口必须位于"工具平衡"边界：
 * 即切口两侧不能有未应答的 tool-call（assistant 的 tool-call 必须与其
 * tool-result 配对）。用于防止压缩切断 tool-call/result 对导致孤立 tool 消息。
 */

/** 工具配对平衡只关心消息的角色与 tool-call/tool-result 块，定义最小结构以兼容各类消息模型 */
export interface PairingMessage {
  role: string
  content: string | ReadonlyArray<{ type?: string }>
}

/** 一条消息对"在途 tool-call 数"的增量：assistant 声明 +N，tool 结果 -1 */
function eventDelta(msg: PairingMessage): number {
  if (msg.role === "assistant") {
    if (typeof msg.content === "string") return 0
    return msg.content.filter(p => p.type === "tool-call").length
  }
  if (msg.role === "tool") return -1
  return 0
}

/**
 * 计算消息序列的切口平衡状态。
 * 序列有 N 条消息 → N+1 个切口（i 表示第 i 条消息前的切口，N 表示末尾）。
 * 返回一个布尔数组，`cutBalanced[i]` 表示第 i 个切口是否工具配对平衡。
 */
export function computeCutBalances(messages: ReadonlyArray<PairingMessage>): boolean[] {
  const balances: boolean[] = [true] // 序列前无内容，天然平衡
  let inProgress = 0
  for (const msg of messages) {
    inProgress += eventDelta(msg)
    // 异常：tool-result 多于 tool-call（数据不一致），保守视为不平衡
    if (inProgress < 0) inProgress = 0
    balances.push(inProgress === 0)
  }
  return balances
}

/**
 * 指定消息索引处的切口是否工具配对平衡。
 * @param messages 消息序列
 * @param index 切口位置：0 = 首条消息前，N = 末尾后
 */
export function isBalancedCut(messages: ReadonlyArray<PairingMessage>, index: number): boolean {
  if (index < 0) return true
  const balances = computeCutBalances(messages)
  if (index >= balances.length) return balances[balances.length - 1]
  return balances[index]
}

/**
 * 从后往前找到最近的工具平衡切口。
 * @param messages 消息序列
 * @param fromIndex 起始切口位置（向后调整）
 * @param minIndex 允许的最小切口位置
 * @returns 满足平衡条件的最大切口位置（≥ minIndex），找不到返回 -1
 */
export function nearestBalancedCut(
  messages: ReadonlyArray<PairingMessage>,
  fromIndex: number,
  minIndex = 0,
): number {
  let cut = fromIndex
  while (cut >= minIndex) {
    if (isBalancedCut(messages, cut)) return cut
    cut--
  }
  return -1
}

/**
 * 从前往后找到最近的工具平衡切口。
 * @param messages 消息序列
 * @param fromIndex 起始切口位置（向前调整）
 * @param maxIndex 允许的最大切口位置
 * @returns 满足平衡条件的最小切口位置（≤ maxIndex），找不到返回 -1
 */
export function nextBalancedCut(
  messages: ReadonlyArray<PairingMessage>,
  fromIndex: number,
  maxIndex: number,
): number {
  let cut = fromIndex
  while (cut <= maxIndex) {
    if (isBalancedCut(messages, cut)) return cut
    cut++
  }
  return -1
}

/**
 * 验证一段消息序列是否是工具配对平衡的（首尾切口都平衡）。
 * 用于压缩区域选择：确保不会切断 tool-call/result 对。
 */
export function isRegionBalanced(
  messages: ReadonlyArray<PairingMessage>,
  startIdx: number,
  endIdx: number,
): boolean {
  return isBalancedCut(messages, startIdx) && isBalancedCut(messages, endIdx + 1)
}
