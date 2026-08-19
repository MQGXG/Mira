import { describe, expect, test } from 'vitest'
import { generateFollowUpSuggestions } from '../follow-up-suggestions'

describe('generateFollowUpSuggestions', () => {
  test('代码回复生成代码相关追问', () => {
    const s = generateFollowUpSuggestions('这里有一段代码：\n```ts\nconst x = 1\n```\n可以优化吗？')
    expect(s.some(p => p.includes('代码'))).toBe(true)
    expect(s.length).toBeGreaterThan(0)
    expect(s.length).toBeLessThanOrEqual(3)
  })

  test('结构化回复生成总结/展开追问', () => {
    const s = generateFollowUpSuggestions('步骤如下：\n1. 安装依赖\n2. 配置环境\n3. 启动服务\n4. 验证结果')
    expect(s.some(p => p.includes('要点') || p.includes('步骤'))).toBe(true)
  })

  test('包含主题词时生成针对该主题的追问', () => {
    const s = generateFollowUpSuggestions('React 的渲染机制很复杂，React 的调度器决定了更新顺序。')
    expect(s.some(p => p.includes('React'))).toBe(true)
  })

  test('空文本返回空数组', () => {
    expect(generateFollowUpSuggestions('')).toEqual([])
    expect(generateFollowUpSuggestions('   ')).toEqual([])
  })

  test('无特征文本走兜底建议', () => {
    const s = generateFollowUpSuggestions('这是一个普通的回答。')
    expect(s.length).toBeGreaterThan(0)
  })
})
