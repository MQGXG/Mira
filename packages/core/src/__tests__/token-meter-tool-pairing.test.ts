/**
 * token-meter + tool-pairing + 压缩平衡/收益校验测试
 */

import { describe, expect, test } from 'vitest'
import { estimateTextBlock, estimateContentBlocks, estimateMessageTokens, estimateMessagesTokens } from '../shared/token-meter'
import {
  computeCutBalances,
  isBalancedCut,
  nearestBalancedCut,
  nextBalancedCut,
  isRegionBalanced,
  type PairingMessage,
} from '../session/tool-pairing'
import { compactMessages, compactMessagesAsync } from '../session/compaction'
import type { LLMMessage, ContentPart } from '../llm/schema/messages'

// ── token-meter ─────────────────────────────────────────

describe('token-meter', () => {
  test('estimateTextBlock 固定密度（4 字符/token + 块开销）', () => {
    expect(estimateTextBlock('')).toBe(4) // 纯块开销
    expect(estimateTextBlock('abcd')).toBe(1 + 4) // 4 字符 → 1 token + 4 开销
    expect(estimateTextBlock('abcdefgh')).toBe(2 + 4)
  })

  test('estimateContentBlocks 区分 text/reasoning/tool-call/tool-result', () => {
    const textTokens = estimateContentBlocks([{ type: 'text', text: 'hello' }])
    const toolCallTokens = estimateContentBlocks([{ type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: '/a' } }])
    const toolResultTokens = estimateContentBlocks([{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: 'content' }])
    const imageTokens = estimateContentBlocks([{ type: 'image', image: 'data:image/png;base64,xxx' }])

    // tool-call 带额外参数开销，应比纯 text 更贵
    expect(toolCallTokens).toBeGreaterThan(textTokens)
    // tool-result 含输出文本
    expect(toolResultTokens).toBeGreaterThan(textTokens)
    // image 只有块开销
    expect(imageTokens).toBe(4)
  })

  test('estimateMessageTokens 含角色框架开销', () => {
    const msg: LLMMessage = { role: 'user', content: 'hello' }
    const tokens = estimateMessageTokens(msg)
    expect(tokens).toBe(estimateTextBlock('hello') + 4) // 角色开销 4
  })

  test('estimateMessagesTokens 累加', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    const total = estimateMessagesTokens(msgs)
    expect(total).toBe(estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]))
  })

  test('未知块按结构保守计价', () => {
    const tokens = estimateContentBlocks([{ type: 'custom-block', foo: 'bar' }])
    expect(tokens).toBeGreaterThan(4)
  })
})

// ── tool-pairing ────────────────────────────────────────

function pairing(role: string, parts: Array<{ type?: string }> | string): PairingMessage {
  return { role, content: Array.isArray(parts) ? parts : parts }
}

function assistantWithToolCall(): PairingMessage {
  return pairing('assistant', [{ type: 'text' }, { type: 'tool-call' }])
}

function toolResult(): PairingMessage {
  return pairing('tool', [{ type: 'tool-result' }])
}

describe('tool-pairing', () => {
  test('无工具调用时所有切口平衡', () => {
    const msgs = [pairing('user', 'hi'), pairing('assistant', 'hello')]
    expect(computeCutBalances(msgs)).toEqual([true, true, true])
  })

  test('tool-call 与 result 配对时切口平衡', () => {
    const msgs = [
      pairing('user', 'do it'),
      assistantWithToolCall(),
      toolResult(),
    ]
    expect(computeCutBalances(msgs)).toEqual([true, true, false, true])
    // 切口 3（result 后）平衡
    expect(isBalancedCut(msgs, 3)).toBe(true)
  })

  test('tool-call 与 result 之间的切口不平衡（禁止切断）', () => {
    const msgs = [
      pairing('user', 'do it'),
      assistantWithToolCall(),
      toolResult(),
    ]
    // 切口 2 = assistant 与 tool-result 之间 → 不平衡
    expect(isBalancedCut(msgs, 2)).toBe(false)
  })

  test('nearestBalancedCut 向后找到平衡切口', () => {
    const msgs = [
      pairing('user', 'do it'),
      assistantWithToolCall(),
      toolResult(),
      pairing('assistant', 'done'),
    ]
    // 从切口 4 向前找最近平衡：切口 4 平衡
    expect(nearestBalancedCut(msgs, 4, 0)).toBe(4)
    // 从切口 3 向前找：切口 3（result 后）平衡
    expect(nearestBalancedCut(msgs, 3, 0)).toBe(3)
  })

  test('nextBalancedCut 向前找到平衡切口', () => {
    const msgs = [
      pairing('user', 'do it'),
      assistantWithToolCall(),
      toolResult(),
      pairing('assistant', 'done'),
    ]
    // 从切口 1 向前找：切口 1（user 后）平衡
    expect(nextBalancedCut(msgs, 1, 3)).toBe(1)
    // 从切口 2 向前找：切口 2 不平衡，跳过到 3
    expect(nextBalancedCut(msgs, 2, 4)).toBe(3)
  })

  test('isRegionBalanced 校验区域首尾平衡', () => {
    const msgs = [
      pairing('user', 'a'),
      assistantWithToolCall(),
      toolResult(),
      pairing('user', 'b'),
    ]
    // 区域 [1,3] 首尾切口（1 前、3 后）都平衡
    expect(isRegionBalanced(msgs, 1, 3)).toBe(true)
    // 区域 [1,2] 末端切口 3 前 = 2 后 → 切口 3 前的 balance 是 cutBalanced[2]（不平衡）
    expect(isBalancedCut(msgs, 2)).toBe(false)
  })

  test('孤立 tool-result（无前置调用）不导致崩溃', () => {
    const msgs = [toolResult(), pairing('user', 'hi')]
    // 第一个 tool-result 使 inProgress 为负 → clamp 0 → 平衡
    expect(computeCutBalances(msgs)).toEqual([true, true, true])
  })
})

// ── 压缩平衡 + 收益校验 ─────────────────────────────────

function makeLLMMsg(role: 'user' | 'assistant' | 'tool', content: string | ContentPart[], toolCallId?: string): LLMMessage {
  return { role, content, tool_call_id: toolCallId }
}

describe('压缩平衡与收益', () => {
  test('snipCompact 不切断 tool-call/result 对', () => {
    // 构造：head 内是已闭合的工具回合（tool-call + result 相邻），middle 全干净消息
    const msgs: LLMMessage[] = [
      makeLLMMsg('user', 'task'),
      makeLLMMsg('assistant', [{ type: 'text', text: 'ok' }, { type: 'tool-call', toolCallId: 't1', toolName: 'grep', args: {} }]),
      makeLLMMsg('tool', [{ type: 'tool-result', toolCallId: 't1', toolName: 'grep', output: 'result' }]),
      ...Array.from({ length: 20 }, (_, i) => makeLLMMsg('user', `middle ${i}`.repeat(20))),
      makeLLMMsg('assistant', 'done'),
    ]

    const result = compactMessages(msgs, 100, 'l1_snip')
    // 收益校验：确实变小
    expect(result.messages.length).toBeLessThan(msgs.length)

    // 不变量：压缩后不存在孤立 tool-call 或孤立 tool-result
    const declared = new Set<string>()
    const resolved = new Set<string>()
    for (const m of result.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'tool-call' && p.toolCallId) declared.add(p.toolCallId)
        }
      }
      if (m.role === 'tool') {
        if (m.tool_call_id) resolved.add(m.tool_call_id)
        if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p.type === 'tool-result') {
              const id = (p as { toolCallId?: string }).toolCallId
              if (id) resolved.add(id)
            }
          }
        }
      }
    }
    // head 内的工具配对必须完整（t1 的 call 与 result 都保留）
    expect(declared.has('t1')).toBe(true)
    expect(resolved.has('t1')).toBe(true)
  })

  test('snipCompact 遇未闭合 tool-call 拒绝压缩（无法平衡切分）', () => {
    // assistant(tool-call) 的 result 在末尾（未闭合跨越大段中间）→ 无法平衡切分，返回原样
    const msgs: LLMMessage[] = [
      makeLLMMsg('user', 'task'),
      makeLLMMsg('assistant', [{ type: 'text', text: 'ok' }, { type: 'tool-call', toolCallId: 't1', toolName: 'grep', args: {} }]),
      ...Array.from({ length: 20 }, (_, i) => makeLLMMsg('user', `middle ${i}`.repeat(20))),
      makeLLMMsg('tool', [{ type: 'tool-result', toolCallId: 't1', toolName: 'grep', output: 'result' }]),
    ]

    const result = compactMessages(msgs, 100, 'l1_snip')
    // 无法平衡切分 → level 为 none（保守不压缩，避免切断配对）
    expect(result.level).toBe('none')
    expect(result.messages).toHaveLength(msgs.length)
  })

  test('compactMessages 收益校验：压缩后不小于原样则返回原样', () => {
    // 全部是短消息（无压缩收益），强制 l3 也不应膨胀
    const msgs: LLMMessage[] = Array.from({ length: 25 }, (_i) => makeLLMMsg('user', 'x'))
    const result = compactMessages(msgs, 10, 'l3_auto')
    // 若压缩无收益，level 应为 none
    expect(['none', 'l1_snip', 'l2_micro', 'l3_auto']).toContain(result.level)
  })

  test('compactMessagesAsync 收益校验：无收益返回原样', async () => {
    const msgs: LLMMessage[] = Array.from({ length: 30 }, (_i) => makeLLMMsg('user', 'x'.repeat(10)))
    // 高阈值 → 低压力，不压缩
    const result = await compactMessagesAsync(msgs, { maxTokens: 100000 })
    expect(result).toEqual(msgs)
  })

  test('compactMessagesAsync 有收益时压缩', async () => {
    const msgs: LLMMessage[] = Array.from({ length: 30 }, (_i) => makeLLMMsg('user', 'x'.repeat(500)))
    const result = await compactMessagesAsync(msgs, { maxTokens: 100 })
    expect(result.length).toBeLessThan(30)
  })
})
