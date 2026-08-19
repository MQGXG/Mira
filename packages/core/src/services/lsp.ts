/**
 * LSP 服务 — ctx.lsp
 * 持有 LSPServerManager（默认共享模块单例 lspManager，setManager 可替换实现）。
 */

import { Service } from "../vendor/cordis/index"
import { LSPServerManager, lspManager } from "../lsp/manager"
import type { LSPService } from "../framework/context"

export class MiraLSPService extends Service implements LSPService {
  static provide = "lsp"

  private manager: LSPServerManager

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { manager?: LSPServerManager }) {
    super(ctx, "lsp")
    this.manager = config?.manager ?? lspManager
  }

  getManager(): LSPServerManager {
    return this.manager
  }

  /** 插件替换 manager（自定义语言服务器编排） */
  setManager(manager: LSPServerManager): void {
    this.manager = manager
  }
}