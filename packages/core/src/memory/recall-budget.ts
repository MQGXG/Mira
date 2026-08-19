/**
 * 记忆召回预算保护 — 参考 TencentDB-Agent-Memory `auto-recall.ts` 的
 * `applyRecallBudget` + `Promise.race` 硬超时设计。
 *
 * 防止召回结果灌爆上下文窗口：逐条截断 + 总字符预算 + 硬超时。
 */

export interface RecallBudget {
  /** 单条记忆最大字符数（0=不限制） */
  maxCharsPerMemory?: number;
  /** 全部召回内容总字符数上限（0=不限制） */
  maxTotalRecallChars?: number;
}

/** 截断后追加的提示（Tencent 用同款中文提示） */
export const TRUNCATION_NOTE = "…（已截断，可用 memory_search 查看详情）";

/** 剩余空间低于此值则整条丢弃，保证截断行仍可读 */
const MIN_TRUNCATED_LINE_CHARS = 40;

/**
 * 按 code point 截断（对齐 Tencent truncateRecallLine）：
 * - 超长则截断到 max 内（后缀计入预算）
 * - 避免拆散代理对/emoji
 */
function truncateByCodePoint(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  if (max <= TRUNCATION_NOTE.length) return cps.slice(0, max).join("");
  return `${cps.slice(0, max - TRUNCATION_NOTE.length).join("").trimEnd()}${TRUNCATION_NOTE}`;
}

/**
 * 逐条应用预算（对齐 Tencent applyRecallBudget）：
 * - 单条超限 → 截断到 maxCharsPerMemory
 * - 运行总字符超限 → 能放下的截断放下，否则丢弃剩余条目
 */
export function applyRecallBudget(lines: string[], budget: RecallBudget): string[] {
  const maxPerItem = budget.maxCharsPerMemory || 0;
  const maxTotal = budget.maxTotalRecallChars || 0;

  if (!maxPerItem && !maxTotal) return lines;

  const out: string[] = [];
  let used = 0;

  for (const line of lines) {
    const perItem = maxPerItem ? truncateByCodePoint(line, maxPerItem) : line;

    if (!maxTotal) {
      out.push(perItem);
      continue;
    }

    const separator = out.length > 0 ? 1 : 0; // "\n"
    const remaining = maxTotal - used - separator;
    if (remaining <= 0) break;

    if (perItem.length > remaining) {
      if (remaining >= MIN_TRUNCATED_LINE_CHARS) {
        const totalBounded = truncateByCodePoint(perItem, remaining);
        out.push(totalBounded);
        used += separator + totalBounded.length;
      }
      break;
    }

    out.push(perItem);
    used += separator + perItem.length;
  }

  return out;
}

/**
 * 硬超时（对齐 Tencent `performAutoRecall` 的 Promise.race 5000ms）。
 * 超时后 reject，由调用方降级为安全空结果。
 */
export function withRecallTimeout<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Memory recall timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
