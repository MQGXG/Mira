/**
 * transformers.js 适配层 — 隔离模型加载与第三方类型缺陷
 *
 * 承接 UI 侧旧实现并下沉 core：加载前确保 `configureTransformersEnv` 已执行
 * （本地模型打包目录 + userData/models-cache 缓存，与向量记忆共用同一缓存策略）。
 *
 * transformers.js 3.0.0-alpha.2 的 `pipeline` 类型定义不完善（返回 unknown、
 * 不支持泛型）。为保持类型整洁，把模型加载与类型断言集中在本层。
 */

type ASRResult = { text?: string }

type TTSResult = { audio: Float32Array; sampling_rate: number }

export interface ASRPipeline {
  (audio: Float32Array, options?: { return_timestamps?: boolean }): Promise<ASRResult | Array<ASRResult> | undefined>
}

export interface TTSPipeline {
  (text: string, options?: Record<string, unknown>): Promise<TTSResult | undefined>
}

let envReady: Promise<void> = Promise.resolve()

/**
 * 模型加载前环境准备。
 *
 * 渲染进程的 transformers.js 使用默认浏览器缓存，无需 Node 配置；
 * Node 侧（主进程/向量记忆）由 memory/transformers-env 先行配置。
 * 故此处不引入 Node 模块，保持 renderer bundle 干净（避免 path/fs 进图）。
 */
function ensureEnv(): Promise<void> {
  return envReady
}

export async function loadASRPipeline(model: string): Promise<ASRPipeline> {
  await ensureEnv()
  const { pipeline } = await import("@huggingface/transformers")
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 第三方类型缺陷，集中豁免
  const p = await pipeline("automatic-speech-recognition", model, { dtype: "q8" })
  return p as ASRPipeline
}

export async function loadTTSPipeline(model: string): Promise<TTSPipeline> {
  await ensureEnv()
  const { pipeline } = await import("@huggingface/transformers")
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 第三方类型缺陷，集中豁免
  const p = await pipeline("text-to-speech", model, { dtype: "q8" })
  return p as TTSPipeline
}