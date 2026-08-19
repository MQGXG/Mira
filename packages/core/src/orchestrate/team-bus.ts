/**
 * 多 Agent 消息总线 — 基于文件收件箱的异步通信
 * 替代 Python team_bus.py
 */

import { join } from "path"
import fs from "fs"
import { randomUUID } from "crypto"
import { getPlatformPaths } from "../config/paths"

export interface Message {
  id: string
  from: string
  to: string
  type: "task" | "result" | "question" | "answer" | "notification"
  content: string
  timestamp: number
  threadId: string
}

export type ProtocolState = "active" | "shutdown" | "plan_approval"

let inboxDir = ""
let protocolState: ProtocolState = "active"

function ensureInboxDir(): string {
  if (!inboxDir) {
    inboxDir = join(getPlatformPaths().userData, "mailboxes")
    if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true })
  }
  return inboxDir
}

function agentInbox(agentId: string): string {
  const dir = join(ensureInboxDir(), agentId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function sendMessage(from: string, to: string, type: Message["type"], content: string, threadId?: string): Message {
  const msg: Message = {
    id: randomUUID(),
    from, to, type, content,
    timestamp: Date.now(),
    threadId: threadId || randomUUID(),
  }
  const inbox = agentInbox(to)
  const filePath = join(inbox, `${msg.id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(msg, null, 2), "utf-8")
  return msg
}

export function readInbox(agentId: string): Message[] {
  const inbox = agentInbox(agentId)
  try {
    return fs.readdirSync(inbox)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(join(inbox, f), "utf-8")) as Message }
        catch { return null }
      })
      .filter((m): m is Message => m !== null)
      .sort((a, b) => a.timestamp - b.timestamp)
  } catch {
    return []
  }
}

export function clearInbox(agentId: string): void {
  const inbox = agentInbox(agentId)
  try {
    for (const f of fs.readdirSync(inbox)) {
      fs.unlinkSync(join(inbox, f))
    }
  } catch { /* 静默 */ }
}

export function setProtocolState(state: ProtocolState): void {
  protocolState = state
}

export function getProtocolState(): ProtocolState {
  return protocolState
}

export function requestPlanApproval(agentId: string, plan: string): Message {
  return sendMessage(agentId, "user", "question", `需要批准计划:\n\n${plan}`)
}


