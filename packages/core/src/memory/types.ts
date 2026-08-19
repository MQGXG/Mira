/**
 * Memory Provider 接口定义
 * 参考 Hermes Agent memory_provider.py / memory_manager.py
 */

export interface MemoryProvider {
  name: string
  initialize(sessionID: string, workspace: string): Promise<void>
  buildSystemPrompt(): string
  prefetch(query: string, sessionID: string): Promise<string>
  syncTurn(user: string, assistant: string, sessionID: string): Promise<void>
  shutdown(): Promise<void>
}
