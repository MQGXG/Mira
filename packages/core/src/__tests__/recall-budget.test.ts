import { describe, expect, test } from 'vitest'
import { applyRecallBudget, withRecallTimeout } from '../memory/recall-budget'

describe('applyRecallBudget', () => {
  test('无预算时原样返回', () => {
    const lines = ['a', 'bb']
    expect(applyRecallBudget(lines, {})).toEqual(lines)
  })

  test('单条预算截断长内容（后缀计入预算）', () => {
    const long = 'x'.repeat(200)
    const out = applyRecallBudget([long], { maxCharsPerMemory: 60 })
    // 60 字符预算内含截断提示
    expect(out[0].length).toBeLessThanOrEqual(60)
    expect(out[0]).toContain('已截断')
  })

  test('预算太小时无后缀（直接截断）', () => {
    const long = 'x'.repeat(200)
    const out = applyRecallBudget([long], { maxCharsPerMemory: 5 })
    expect(out[0]).toBe('xxxxx')
    expect(out[0]).not.toContain('已截断')
  })

  test('总预算丢弃超限条目（能截断的截断）', () => {
    const a = 'a'.repeat(100)
    const b = 'b'.repeat(100)
    const out = applyRecallBudget([a, b], { maxTotalRecallChars: 60 })
    expect(out.length).toBe(1) // a 截断放下，b 丢弃
    expect(out[0].length).toBeLessThanOrEqual(60)
    expect(out[0]).toContain('已截断')
  })

  test('总预算足够时全部保留', () => {
    const lines = ['aaa', 'bbb']
    const out = applyRecallBudget(lines, { maxTotalRecallChars: 1000 })
    expect(out).toEqual(lines)
  })

  test('emoji 不被拆散（按 code point 截断，无替换符）', () => {
    const emoji = '😀'.repeat(50)
    const out = applyRecallBudget([emoji], { maxCharsPerMemory: 30 })
    // code point 截断保证不产生 U+FFFD 替换符（若按 UTF-16 单元截断会出现半截代理对）
    expect(out[0]).not.toContain('\uFFFD')
    expect(out[0]).toContain('😀')
    expect(Array.from(out[0]).length).toBeLessThanOrEqual(30) // 按 code point ≤ 预算
  })
})

describe('withRecallTimeout', () => {
  test('正常完成返回结果', async () => {
    const r = await withRecallTimeout(() => Promise.resolve('ok'), 5000)
    expect(r).toBe('ok')
  })

  test('超时 reject', async () => {
    await expect(
      withRecallTimeout(() => new Promise<string>((r) => setTimeout(() => r('late'), 200)), 50),
    ).rejects.toThrow(/timed out/)
  })
})
