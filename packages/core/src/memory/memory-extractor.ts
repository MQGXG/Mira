/**
 * 会话结束自动记忆提取（Session-end memory extraction）。
 *
 * 会话结束后，用轻量文本模型读取本次会话转写，提出值得跨会话长期记住的
 * 用户个人事实并写入记忆存储。设计刻意保守：
 *
 * 安全不变量（不可削弱）：
 * - 只写入 FTS 记忆表，来源标记 source: "inferred"，可在不影响人工记忆的前提下批量回退。
 * - 每次自动写入都带敏感内容二次过滤：宁可漏存，不可存秘。
 * - 失败静默：提取绝不能延迟或阻断会话结束。
 *
 * 参考实现：qwen-audio-agent memory-extractor.mjs（invisible-memory 设计 P0）。
 */

const MAX_OPS_PER_RUN = 5
const MAX_FACT_CHARS = 100

// 提取器提示词之外的敏感内容闸门。保守设计：误判只丢弃一条候选事实，漏判会持久化一个秘密。
export const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)/i,
  /(?:密码|密钥|口令|验证码|令牌|证件号|身份证)/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\b\d{11,19}\b/,
  /[A-Za-z0-9+/]{40,}={0,2}/,
]

export const EXTRACTOR_SYSTEM_PROMPT = [
  "你是一个记忆提取器，从智能助手与用户的对话转写中提取值得跨会话长期记住的用户个人事实。",
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"ops":[{"action":"add","kind":"stated","type":"persona","priority":80,"content":"用户……"}]}',
  "",
  "规则：",
  '- 只提取用户本人陈述的、稳定的个人事实：身份、称呼、偏好、习惯、人际关系、长期目标或计划。',
  "- kind 只能是 stated 或 inferred：stated 表示用户明确陈述（如\"我是、我喜欢、我每天\"）；inferred 表示从上下文推测。拿不准时用 inferred。",
  "- type 只能是 persona（稳定属性/偏好/身份）、episodic（已发生的客观事件/决定/计划）、instruction（要求 AI 长期遵守的行为规则）三类。",
  "- priority 是 0-100 的整数：persona 中健康/禁忌/核心特质 80-100，一般喜好 50-70；episodic 重要事件 80-100，一般活动 60-70，琐事直接丢弃；instruction 严格全局规则 90-100，一般要求 70-80。",
  '每条 content 不超过 50 字，以"用户"开头，脱离对话也能独立成立。',
  "- 不提取：一次性情绪、临时安排、本次任务的执行细节、助手自身的行为、常识、随时可以再查到的事实。",
  "- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址信息。",
  '""已有记忆""里已经覆盖的事实不要重复输出。',
  '没有值得记住的内容时输出 {"ops":[]}。',
].join("\n")

export interface ExtractedMessage {
  role: string
  content: string
}

/** 轻量文本模型的单次补全调用。返回纯文本，null 表示通道不可用（提取器因此静默停用）。 */
export type ExtractorLlmCall = (input: { system: string; user: string }) => string | Promise<string>

/** 已写记忆的查询/写入接口。现按会话隔离。 */
export interface MemoryExtractorStore {
  list(sessionID: string, limit: number): Array<{ content: string }> | Promise<Array<{ content: string }>>
  remember(content: string, sessionID: string, source?: string): void | Promise<void>
}

export interface MemoryExtractorOptions {
  store: MemoryExtractorStore
  listMessages: (sessionID: string) => Array<ExtractedMessage> | Promise<Array<ExtractedMessage>>
  llmCall?: ExtractorLlmCall | null
  audit?: { record(entry: Record<string, unknown>): void } | null
  logger?: { warn?(...args: unknown[]): void; debug?(...args: unknown[]): void }
  now?: () => number
  debounceMs?: number
  minUserMessages?: number
  maxTranscriptChars?: number
  /** 是否保留推测性事实（kind: inferred）。默认 false（保守，只保留明确陈述） */
  keepInferred?: boolean
}

export function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
}

export function cleanFact(value: unknown): string {
  const text = toSafeString(value)
  return [...text.replace(/\s+/g, " ").trim()]
    .slice(0, MAX_FACT_CHARS)
    .join("")
}

/** 提取的记忆类型（对齐 Tencent L1：persona/episodic/instruction） */
export type MemoryType = "persona" | "episodic" | "instruction"

export interface ExtractedOp {
  action: string
  kind: string
  content: string
  /** 结构化记忆类型（可选，兼容旧格式） */
  type?: MemoryType
  /** 优先级 0-100（可选） */
  priority?: number
}

/** 模型可能包一层 Markdown 代码围栏，需先剥掉再解析。 */
export function parseOps(text: string): ExtractedOp[] {
  const raw = String(text || "").trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
  const parsed: unknown = JSON.parse(unfenced)
  const ops = (parsed as { ops?: Array<ExtractedOp> } | null)?.ops
  if (!ops || !Array.isArray(ops)) {
    throw new Error("提取器输出缺少 ops 数组")
  }
  return ops
}

/** 将 catch 的 unknown 转为可读字符串（Mira tsconfig 启用 useUnknownInCatchVariables） */
function toSafeString(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return value ? JSON.stringify(value) : ""
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : toSafeString(error)
}

/** 将消息序列化为转写行，超预算时保留最近若干轮。 */
export function transcriptLines(messages: Array<ExtractedMessage>, maxChars: number): string[] {
  const lines: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const content = String(message.content || "").replace(/\s+/g, " ").trim()
    if (!content) continue
    const line = `${message.role === "user" ? "用户" : "助手"}: ${content}`
    if (lines.length && used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
  }
  return lines
}

/**
 * 生产用 llmCall：基于 Mira 的 LLM 客户端封装一次无工具聊天补全。
 * 无可用配置时返回 null（提取器静默停用）。
 */
export function createExtractorLlmCall(config: {
  provider: string
  model: string
  apiKey: string
  apiUrl?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}): Promise<ExtractorLlmCall | null> {
  try {
    if (!config || !config.apiKey || !config.model) return Promise.resolve(null)
    // 动态 import 避免与 llm/client 形成静态循环依赖（与该文件在依赖图中的位置无关时走这里）
    return import("../llm/client").then(({ createLLMClient }) => {
      const client = createLLMClient({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        headers: config.headers,
        options: config.options,
      })
      return async ({ system, user }): Promise<string> => {
        let raw = ""
        for await (const event of client.stream({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        })) {
          if (event.type === "delta") raw += event.delta
          if (event.type === "error") {
            throw new Error(`memory extractor request failed: ${event.error.message}`)
          }
        }
        return raw
      }
    })
  } catch {
    return Promise.resolve(null)
  }
}

export class MemoryExtractor {
  private store: MemoryExtractorStore
  private listMessages: (sessionID: string) => Array<ExtractedMessage> | Promise<Array<ExtractedMessage>>
  private llmCall: ExtractorLlmCall | null
  private audit: MemoryExtractorOptions["audit"] | null
  private logger: NonNullable<MemoryExtractorOptions["logger"]>
  private now: () => number
  private debounceMs: number
  private minUserMessages: number
  private maxTranscriptChars: number
  private keepInferred: boolean
  private lastRunAt = new Map<string, number>()

  constructor(options: MemoryExtractorOptions) {
    this.store = options.store
    this.listMessages = options.listMessages
    this.llmCall = options.llmCall || null
    this.audit = options.audit || null
    this.logger = options.logger || {}
    this.now = options.now || (() => Date.now())
    this.debounceMs = options.debounceMs ?? 30 * 60_000
    this.minUserMessages = options.minUserMessages ?? 4
    this.maxTranscriptChars = options.maxTranscriptChars ?? 6000
    this.keepInferred = options.keepInferred ?? false
  }

  enabled(): boolean {
    return typeof this.llmCall === "function" && Boolean(this.store)
  }

  /**
   * 会话结束 hook：同步完成门控，fire-and-forget。返回的 Promise 仅供测试，永不 reject。
   */
  async maybeRun(sessionID: string): Promise<void | null> {
    if (!this.enabled()) return null
    const lastRunAt = this.lastRunAt.get(sessionID)
    if (lastRunAt !== undefined && this.now() - lastRunAt < this.debounceMs) {
      return null
    }
    const messages = await this.listMessages(sessionID)
    const userMessages = messages.filter((message) => message.role === "user")
    if (userMessages.length < this.minUserMessages) return null
    this.lastRunAt.set(sessionID, this.now())
    return this.run({ sessionID, messages }).catch((error) => {
      this.audit?.record({
        op: "error",
        sessionID,
        error: errMsg(error),
      })
      this.logger.warn?.("memory.extract_failed", { error: errMsg(error) })
    })
  }

  async run({ sessionID, messages }: { sessionID: string; messages: Array<ExtractedMessage> }): Promise<void> {
    const lines = transcriptLines(messages, this.maxTranscriptChars)
    if (!lines.length) return
    const existing = await this.store.list(sessionID, 64)
    const existingValues = new Set(existing.map((m) => String(m.content || "").toLocaleLowerCase()))
    const user =
      [
        "## 已有记忆",
        existing.length ? existing.map((memory) => `- ${memory.content}`).join("\n") : "（无）",
        "",
        "## 对话转写",
        lines.join("\n"),
      ].join("\n") +
      (existing.length ? "\n\n注：上面已有记忆中的内容除非用户再次明确提及，否则不要重复。" : "")

    let ops: ExtractedOp[] = []
    try {
      ops = parseOps(await this.llmCall!({ system: EXTRACTOR_SYSTEM_PROMPT, user }))
    } catch (error) {
      // 解析失败只丢弃本次提取
      this.logger.debug?.("memory.extract_parse_failed", { error: errMsg(error) })
      return
    }

    let written = 0
    for (const op of ops.slice(0, MAX_OPS_PER_RUN)) {
      const content = cleanFact(op?.content || "")
      if (!content) continue
      // 默认只保留明确陈述（stated）；推测性事实（inferred）默认丢弃，
      // 可通过 keepInferred 开关保留（写入时降低 priority 以区分可信度）。
      if (op?.action !== "add" || (op.kind !== "stated" && !(this.keepInferred && op.kind === "inferred"))) {
        this.audit?.record({ op: "skip", sessionID, reason: "not_stated" })
        continue
      }
      if (containsSensitiveContent(content)) {
        // 永不把被拒秘钥回显到审计记录。
        this.audit?.record({ op: "skip", sessionID, reason: "sensitive" })
        continue
      }
      // 结构化类型前缀（对齐 Tencent L1：persona/episodic/instruction），
      // 便于召回时区分记忆性质；旧格式无 type 时不加前缀，保持兼容。
      const type = op.type === "persona" || op.type === "episodic" || op.type === "instruction"
        ? op.type
        : undefined
      const stored = type ? `[${type}] ${content}` : content
      if (existingValues.has(stored.toLocaleLowerCase())) {
        this.audit?.record({ op: "skip", sessionID, reason: "duplicate" })
        continue
      }
      try {
        await this.store.remember(stored, sessionID, "inferred")
        existingValues.add(stored.toLocaleLowerCase())
        written += 1
        this.audit?.record({ op: "write", sessionID, content: stored, source: "inferred", type })
      } catch (error) {
        // 持久化失败：跳过剩余，静默收尾。
        this.audit?.record({ op: "error", sessionID, error: errMsg(error) })
        break
      }
    }
    this.logger?.debug?.("memory.extract_completed", { ops: ops.length, written })
  }
}

/**
 * 模块级默认提取器（fire-and-forget 接入点）。
 * 应用层在会话结束时调用 `runSessionMemoryExtraction`，内部短路于此全局实例。
 */
export let sessionMemoryExtractor: MemoryExtractor | null = null

export function setSessionMemoryExtractor(extractor: MemoryExtractor | null): void {
  sessionMemoryExtractor = extractor
}

/**
 * 会话结束时的默认接入：若已配置全局提取器则调用，否则短路。
 * 永不 reject（maybeRun 内部已 catch）。
 */
export function runSessionMemoryExtraction(sessionID: string): Promise<void | null> | null {
  return sessionMemoryExtractor?.maybeRun(sessionID) ?? null
}