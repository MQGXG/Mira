/**
 * 回归测试：验证发送队列闭包修复（ref 模式）
 *
 * 背景：MiraRuntimeProvider 的 queue 用 useState 只创建一次，其 run 闭包若直接
 * 捕获首次渲染的 sendMessage，会导致 sessionId 始终为空 → 每次发送都新建会话。
 * 修复后用 ref 保存最新 sendMessage，run 经 ref 调用。此测试用真实的
 * createMessageQueue（assistant-ui）验证该模式。
 */
import { describe, it, expect } from "vitest"
import { createMessageQueue, type AppendMessage } from "@assistant-ui/react"

function makeMessage(text: string): AppendMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date(),
    metadata: {},
  } as unknown as AppendMessage
}

function getText(message: AppendMessage): string {
  const part = message.content[0] as { text?: string }
  return part?.text ?? ""
}

describe("发送队列 ref 闭包修复", () => {
  it("sessionId 变化后，queue.run 应使用最新 sessionId（不新建会话）", async () => {
    let sessionId = ""
    const calls: Array<{ sessionId: string; content: string }> = []
    // 模拟 React useRef + useEffect：每次渲染把最新 sendMessage 写入 ref
    const sendMessageRef: { current: ((content: string) => void) | null } = { current: null }
    function render(): void {
      const send = (content: string) => calls.push({ sessionId, content })
      sendMessageRef.current = send
    }

    // queue 只创建一次（useState 初始化），run 通过 ref 取最新 sendMessage
    let notifyIdle: (() => void) | null = null
    const queue = createMessageQueue({
      run: async (message: AppendMessage) => {
        sendMessageRef.current!(getText(message))
        notifyIdle?.() // 模拟真实应用中 chat.isRunning 变 false 后 notifyIdle
      },
    })
    notifyIdle = queue.notifyIdle

    // 首次渲染：sessionId 为空 → 发送应在空会话
    render()
    queue.adapter.enqueue(makeMessage("hello"), { steer: false })
    await new Promise((r) => setTimeout(r, 5))
    expect(calls[0]).toEqual({ sessionId: "", content: "hello" })

    // sessionId 变为 A（App.setActiveSession 后重渲染，useEffect 更新 ref）
    sessionId = "A"
    render()
    queue.adapter.enqueue(makeMessage("world"), { steer: false })
    await new Promise((r) => setTimeout(r, 5))

    // 关键断言：第二次发送必须携带最新 sessionId=A
    expect(calls[1]).toEqual({ sessionId: "A", content: "world" })
  })

  it("若未修复（run 直接捕获首次 sendMessage），第二次会错误使用旧 sessionId", async () => {
    let sessionId = ""
    const calls: Array<{ sessionId: string; content: string }> = []
    // 旧 bug 模拟：queue 初始化（useState）时直接捕获首次渲染的 sendMessage，
    // 且之后永不更新（等价于 run 闭包里的 chat.sendMessage 是首次渲染的）
    let firstSend: ((content: string) => void) | null = null
    function render(): void {
      // 真实旧 bug：useCallback 捕获 sessionId 参数【值】（非引用），首次渲染为 ""
      const captured = sessionId
      const send = (content: string) => calls.push({ sessionId: captured, content })
      if (!firstSend) firstSend = send
    }
    let notifyIdle: (() => void) | null = null
    const queue = createMessageQueue({
      run: async (message: AppendMessage) => {
        firstSend!(getText(message))
        notifyIdle?.()
      },
    })
    notifyIdle = queue.notifyIdle

    // 首次渲染 sessionId="" → 闭包捕获 ""
    render()
    queue.adapter.enqueue(makeMessage("hello"), { steer: false })
    await new Promise((r) => setTimeout(r, 5))
    // sessionId 变化，但旧闭包（firstSend）仍捕获首次的 ""
    sessionId = "A"
    render()
    queue.adapter.enqueue(makeMessage("world"), { steer: false })
    await new Promise((r) => setTimeout(r, 5))

    expect(calls[1]).toEqual({ sessionId: "", content: "world" }) // ← 旧 bug 的表现
  })
})
