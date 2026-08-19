/**
 * LLM 服务 — ctx.llm
 * 对齐 dsh ctx.llm seam：客户端工厂 + 模型目录
 */

import { Service } from "../vendor/cordis/index"
import { createLLMClient } from "../llm/client"
import type { LLMClient, LLMRequest2 } from "../llm/client"
import { ProviderCatalog } from "../llm/provider-catalog"
import type { ModelDef, ProviderDef } from "../llm/provider-catalog"
import type { LLMTurnConfig } from "../agent/turn"
import type { LLMService } from "../framework/context"

export class MiraLLMService extends Service implements LLMService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "llm"
  /** 依赖 Provider 目录服务（就绪后才激活） */
  static inject = ["catalog"]

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "llm")
  }

  createClient(config: LLMTurnConfig): LLMClient {
    return createLLMClient(config)
  }

  listModels(providerId?: string): ModelDef[] {
    return ProviderCatalog.listModels(providerId)
  }

  listProviders(): ProviderDef[] {
    return ProviderCatalog.listProviders()
  }

  /** 流式调用（Agent 循环使用） */
  stream(config: LLMTurnConfig, request: Omit<LLMRequest2, "tools">) {
    const client = this.createClient(config)
    return client.stream(request)
  }
}
