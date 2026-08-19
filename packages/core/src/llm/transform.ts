import { LLMError } from "./schema/errors"
import type { LLMMessage, ImagePart } from "./schema/messages"
import { ProviderCatalog } from "./provider-catalog"

/**
 * 多模态视觉桥（Multimodal Bridge）
 *
 * 参考 mimo `model-cell` 的 multimodalBridge()。
 * 当主模型不支持视觉而消息中携带图片时，
 * 将图片交给独立的视觉模型描述，再把描述以文本替换回原消息，
 * 让纯文本模型也能"看懂"图片。
 */

export interface VisionModelConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

export interface ImageAnalysis {
  data: string
  mediaType: string
}

/**
 * 收集 user 消息中的全部图片（data URL 或远程 URL）。
 */
export function collectImages(msgs: LLMMessage[]): ImageAnalysis[] {
  const images: ImageAnalysis[] = []
  for (const msg of msgs) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type !== "image") continue
      const img = part
      const imageStr = String(img.image)
      const mediaType = img.mediaType ?? (imageStr.startsWith("data:")
        ? imageStr.split(";")[0].replace("data:", "")
        : "image/png")
      images.push({ data: imageStr, mediaType })
    }
  }
  return images
}

/** 消息中是否存在图片 part */
export function hasImageContent(msgs: LLMMessage[]): boolean {
  return collectImages(msgs).length > 0
}

/**
 * 判断 provider/model 是否具备 vision 能力。
 * 优先级：用户声明的 modelVision（自定义模型按类型标记）> capabilities 标记（内置模型）。
 * 未注册能力的模型视为不支持视觉（需要桥）。
 */
export function modelHasVision(provider: string, modelId: string, declaredVision?: boolean): boolean {
  if (typeof declaredVision === "boolean") return declaredVision
  const prov = ProviderCatalog.getProvider(provider)
  if (!prov) return false
  const model = prov.models.find((m) => m.id === modelId)
  if (!model) return false
  return !!model.capabilities?.includes("vision")
}

/** 注入式桥接运行时（默认为 createLLMClient，可注入便于测试） */
export interface BridgeRuntime {
  complete(request: { messages: LLMMessage[] }): Promise<{ content: string }>
}

async function createVisionRuntime(config: VisionModelConfig): Promise<BridgeRuntime> {
  const { createLLMClient } = await import("./client")
  return createLLMClient({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    headers: config.headers,
    options: config.options,
  })
}

/**
 * 多模态桥：把 user 消息中的全部图片替换为视觉模型生成的文本描述。
 * 分析失败时抛错（由调用方决定回落）。
 */
export async function multimodalBridge(
  msgs: LLMMessage[],
  visionModel: VisionModelConfig,
  runtime?: BridgeRuntime,
): Promise<LLMMessage[]> {
  const images = collectImages(msgs)
  if (images.length === 0) return msgs

  const bridge = runtime ?? (await createVisionRuntime(visionModel))

  const visionContent: Array<ImagePart | { type: "text"; text: string }> = [
    ...images.map((img) => ({
      type: "image" as const,
      image: img.data,
      mediaType: img.mediaType,
    })),
    {
      type: "text" as const,
      text:
        "请仔细查看以上所有图片，并完整描述每张图片的实际内容：场景、人物、物体、文字、布局、色彩、氛围等所有可见细节。" +
        "图片可以是任意内容，不限于软件开发相关。若图片包含编程或代码相关内容，请额外保留这些细节（代码、报错、UI、文件结构、终端输出、数据可视化等）。" +
        "无论图片内容是什么，都必须完整描述图片本身，不得只判断'与软件开发无关'而不展开描述。如果有多张图片，请分别描述每张图片的内容。",
    },
  ]

  let description: string
  try {
    const result = await bridge.complete({
      messages: [{ role: "user", content: visionContent }],
    })
    description = result.content || ""
    // 兜底：视觉桥返回过短内容（如仅"无软件开发相关细节"）视为分析失败，走回落逻辑而非注入无意义文本
    if (description.trim().length < 10) {
      throw new Error(`vision description too short (${description.trim().length} chars)`)
    }
  } catch (err) {
    throw LLMError.provider(visionModel.provider, `Vision model analysis failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg
    const hasImg = msg.content.some((p) => p.type === "image")
    if (!hasImg) return msg
    return {
      ...msg,
      content: msg.content.map((p) =>
        p.type === "image"
          ? { type: "text" as const, text: `[多模态视觉分析] ${description}` }
          : p,
      ),
    }
  })
}