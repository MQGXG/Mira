/**
 * 模型识图策略决策模块（② 应用逻辑层唯一决策点）
 *
 * 职责：
 * - 判断模型类型（Core 模型目录能力优先，用户声明的 type 兜底）
 * - 决策识图策略：direct（直发图片）/ bridge（视觉桥描述）/ blocked（阻止发送）
 * - 图片安全校验（数量 / 大小 / 格式白名单）
 *
 * 分层约定：
 * - 只依赖 provider-data.ts 的数据访问，不触碰 IPC / 核心层
 * - 决策结果由上层（session-runtime-store / useVisionPolicy）装配成 config
 * - 模型能力（vision 等）来自 Core 目录（getProviderCatalog，含内置 JSON + 用户 models.json + 插件注册），
 *   本地不再维护白名单（一切皆插件，与 Core 单一数据源对齐）
 */
import type { Provider, ModelType } from "./types"
import { getProviderById, loadProviders } from "./provider-data"
import { ConfigService } from "../services/config.service"

/** 归一化 provider id：custom- 前缀映射为 custom */
function normalizeProviderId(id: string): string {
  return id.startsWith("custom-") ? "custom" : id
}

// ── Core 模型目录能力缓存（providerId → modelId → capabilities[]）─────────

let catalogCapabilities: Record<string, Record<string, string[]>> = {}
let catalogPromise: Promise<void> | null = null

/** 从 Core 拉取模型目录能力（一次性缓存；失败则保持空目录不阻塞） */
async function ensureCatalogLoaded(): Promise<void> {
  if (catalogPromise) return catalogPromise
  catalogPromise = (async () => {
    try {
      const catalog = await ConfigService.getProviderCatalog()
      catalogCapabilities = {}
      for (const p of catalog) {
        catalogCapabilities[p.id] = {}
        for (const m of p.models) {
          catalogCapabilities[p.id][m.id] = m.capabilities || []
        }
      }
    } catch {
      catalogCapabilities = {}
    }
  })()
  return catalogPromise
}

/** 同步查询目录缓存：provider/model 是否具备 vision 能力（容忍 custom- 前缀） */
export function hasCatalogVision(provider: string, modelId: string): boolean {
  for (const key of [provider, provider.replace(/^custom-/, "")]) {
    const models = catalogCapabilities[key]
    if (!models) continue
    const caps = models[modelId]
    if (caps && caps.includes("vision")) return true
  }
  return false
}

/** 模型类型是否支持直接识图（vision / multimodal） */
export function isVisionType(type?: ModelType): boolean {
  return type === "vision" || type === "multimodal"
}

/**
 * 判断 provider/model 是否具备视觉能力。
 * 优先级：Core 目录能力（vision）> 用户声明的 type（vision/multimodal）。
 * 目录能力为权威（含用户 models.json / 插件注册的能力），用户 type 仅作兜底覆盖。
 */
export function isVisionModel(
  provider: string,
  modelId: string,
  modelType?: ModelType,
): boolean {
  if (hasCatalogVision(provider, modelId)) return true
  if (isVisionType(modelType)) return true
  return false
}

/** 视觉桥模型候选（含鉴权信息） */
export interface VisionBridgeCandidate {
  provider: string
  model: string
  apiKey: string
  apiUrl?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

/** 识图策略决策结果 */
export type VisionPolicy =
  | { strategy: "direct" }
  | { strategy: "bridge"; visionModel: VisionBridgeCandidate }
  | { strategy: "blocked"; reason: string }

/**
 * 从已配置 provider 中寻找可用的视觉模型（启用 + 有 apiKey）。
 * 优先用户声明的 vision/multimodal 类型，其次 Core 目录能力（vision）。
 */
export async function findVisionBridgeModel(providers: Provider[]): Promise<VisionBridgeCandidate | null> {
  await ensureCatalogLoaded()
  for (const p of providers) {
    if (!p.enabled) continue
    const pid = normalizeProviderId(p.id)
    const visionModel = p.models.find((m) => {
      if (!m.enabled) return false
      if (m.type && isVisionType(m.type)) return true
      return hasCatalogVision(pid, m.id)
    })
    if (!visionModel) continue
    const info = await getProviderById(pid)
    if (info?.apiKey) {
      return {
        provider: pid,
        model: visionModel.id,
        apiKey: info.apiKey,
        apiUrl: info.apiUrl,
        headers: info.headers,
        options: info.options,
      }
    }
  }
  return null
}

/**
 * 决策识图策略（唯一决策入口）。
 *
 * 规则：
 * 1. 用户手动指定的视觉桥模型（override）优先
 * 2. 当前模型 type 为 vision/multimodal（或目录能力含 vision）→ direct 直发
 * 3. 其余类型（text/voice/未标记/未知）→ 自动推导视觉桥模型
 *    - 找到 → bridge
 *    - 找不到 → blocked（上层应提示且不发送图片）
 */
export async function decideVisionPolicy(
  currentProvider: string,
  currentModel: string,
  currentType?: ModelType,
  override?: { provider: string; model: string },
): Promise<VisionPolicy> {
  await ensureCatalogLoaded()

  // 1) 用户手动指定的视觉桥模型（设置面板覆盖）
  if (override?.provider && override?.model) {
    const info = await getProviderById(override.provider)
    if (info?.apiKey) {
      return {
        strategy: "bridge",
        visionModel: {
          provider: override.provider,
          model: override.model,
          apiKey: info.apiKey,
          apiUrl: info.apiUrl,
          headers: info.headers,
          options: info.options,
        },
      }
    }
  }

  // 2) 当前模型本身支持视觉 → 直发图片
  if (isVisionModel(currentProvider, currentModel, currentType)) {
    return { strategy: "direct" }
  }

  // 3) 非视觉模型 → 自动推导视觉桥模型
  const providers = await loadProviders()
  const bridge = await findVisionBridgeModel(providers)
  if (bridge) return { strategy: "bridge", visionModel: bridge }
  return {
    strategy: "blocked",
    reason: "当前模型不支持识图，且未配置可用的视觉桥模型。请在设置中添加并启用一个视觉模型，或更换为支持视觉的模型。",
  }
}

// ── 图片安全校验 ──────────────────────────────────────

export const MAX_IMAGE_COUNT = 4
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4MB

/** 校验图片 data URL：接受常见位图格式或 PDF（PDF 走视觉桥）；SVG 可含脚本，明确拒绝 */
export function isValidImageDataUrl(url: string): boolean {
  return /^data:(image\/(png|jpe?g|gif|webp|bmp|avif|tiff|heic|heif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(url)
}

/** 校验图片 base64 体积（去除 data URL 前缀后） */
export function imageDataSize(url: string): number {
  const comma = url.indexOf(",")
  if (comma < 0) return 0
  const b64 = url.slice(comma + 1)
  return Math.floor((b64.length * 3) / 4)
}

export interface ImageValidation {
  ok: boolean
  reason?: string
}

/**
 * 批量校验上传媒体（图片/PDF）。
 * 失败返回原因，供上层提示并阻止发送。
 */
export function validateImages(images: string[]): ImageValidation {
  if (images.length === 0) return { ok: true }
  if (images.length > MAX_IMAGE_COUNT) {
    return { ok: false, reason: `一次最多上传 ${MAX_IMAGE_COUNT} 个文件` }
  }
  for (const img of images) {
    if (!isValidImageDataUrl(img)) {
      return { ok: false, reason: "仅支持 PNG / JPG / GIF / WebP 图片或 PDF 文档" }
    }
    const isPdf = img.startsWith("data:application/pdf;")
    // PDF 走视觉桥，允许更大体积（受附件总预算约束）
    const limit = isPdf ? 20 * 1024 * 1024 : MAX_IMAGE_BYTES
    if (imageDataSize(img) > limit) {
      return { ok: false, reason: isPdf ? "PDF 不能超过 20MB" : "单张图片不能超过 4MB" }
    }
  }
  return { ok: true }
}
