/**
 * 会话服务 — ctx.sessions
 * 对齐 dsh ctx.sessions seam：会话 CRUD + 事件溯源存取
 */

import { Service } from "../vendor/cordis/index"
import {
  createSession as sqliteCreateSession,
  listSessions as sqliteListSessions,
  deleteSessionById,
} from "../session/manager"
import { loadSession } from "../session/store"
import type { SessionInfo } from "../session/manager"
import type { StoredSession } from "../session/store"
import type { SessionService } from "../framework/context"

export class MiraSessionService extends Service implements SessionService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "sessions"
  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "sessions")
  }

  async createSession(projectId: string, title?: string): Promise<SessionInfo> {
    return sqliteCreateSession(projectId, title)
  }

  async getSession(id: string): Promise<StoredSession | null> {
    return loadSession(id)
  }

  async listSessions(projectId?: string): Promise<SessionInfo[]> {
    return sqliteListSessions(projectId)
  }

  async deleteSession(id: string): Promise<void> {
    await deleteSessionById(id)
  }
}
