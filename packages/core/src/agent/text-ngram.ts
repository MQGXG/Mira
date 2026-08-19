/**
 * Text N-gram 重复检测 — 参考 MiMo-Code 的 text-ngram-detection
 * 检测流式输出中的重复模式，自动停止循环
 */

const WINDOW_SIZE = 50 // 检测窗口大小（字符）
const MIN_REPEAT_LENGTH = 20 // 最小重复长度
const REPEAT_THRESHOLD = 3 // 重复次数阈值

export class TextNgramMonitor {
  private buffer = ""
  private repeatCount = 0
  private lastPattern = ""

  /**
   * 检查文本是否包含重复模式
   * @param delta 新增的文本片段
   * @returns true 表示检测到重复，应停止
   */
  check(delta: string): boolean {
    this.buffer += delta

    // 保持窗口大小
    if (this.buffer.length > WINDOW_SIZE * 2) {
      this.buffer = this.buffer.slice(-WINDOW_SIZE * 2)
    }

    // 检测最近的重复模式
    const recent = this.buffer.slice(-WINDOW_SIZE)
    const pattern = this.findRepeatPattern(recent)

    if (pattern && pattern.length >= MIN_REPEAT_LENGTH) {
      if (pattern === this.lastPattern) {
        this.repeatCount++
        if (this.repeatCount >= REPEAT_THRESHOLD) {
          return true // 重复超过阈值
        }
      } else {
        this.lastPattern = pattern
        this.repeatCount = 1
      }
    }

    return false
  }

  /**
   * 查找重复模式
   * 在文本末尾查找重复出现的子串
   */
  private findRepeatPattern(text: string): string | null {
    // 从最长可能的模式开始检查
    const maxPatternLen = Math.floor(text.length / 2)
    for (let len = maxPatternLen; len >= MIN_REPEAT_LENGTH; len--) {
      const candidate = text.slice(-len)
      const prev = text.slice(-len * 2, -len)
      if (candidate === prev) {
        return candidate
      }
    }
    return null
  }

  reset(): void {
    this.buffer = ""
    this.repeatCount = 0
    this.lastPattern = ""
  }
}

/**
 * 检查文本是否有明显的重复段落
 * 用于在工具执行后检查结果
 */
export function hasRepeatedContent(text: string, minLength = 100): boolean {
  if (text.length < minLength) return false

  // 检查连续重复段落
  const halfLen = Math.floor(text.length / 2)
  const firstHalf = text.slice(0, halfLen)
  const secondHalf = text.slice(halfLen)

  if (firstHalf === secondHalf) return true

  // 检查短模式重复
  for (let patternLen = 20; patternLen <= 100; patternLen++) {
    const pattern = text.slice(-patternLen)
    const occurrences = (text.match(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    if (occurrences >= 5) return true
  }

  return false
}
