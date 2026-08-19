/**
 * Transformers.js 环境配置 — 本地模型路径 + 下载缓存
 *
 * 背景：@huggingface/transformers v3.0.0-alpha.2 的 webpack 产物在 Node 下
 * `IS_FS_AVAILABLE=false`（browser 字段把 fs 置空，上游打包缺陷），导致：
 *   - env.localModelPath 本地文件读取失效（useFS=false 时走 fetch）
 *   - env.useFSCache 磁盘缓存失效（FileCache 不可用）
 * 唯一可控扩展点是 env.customCache（Web Cache API 接口：match/put）。
 *
 * 本模块通过 customCache 实现"打包优先 → 缺失在线下载 → 持久化缓存"：
 *   match(key)  按优先级读取本地文件：打包目录（resources/models）→ 下载缓存（userData/models-cache）
 *   put(key)    把下载到的文件写盘到缓存目录，二次启动直接命中
 *
 * transformers.js 会以两种 key 调用 match/put：
 *   - 本地绝对路径（{localModelPath}/{repo}/{file}，由 getModelFile 拼接）
 *   - 远程 URL（https://huggingface.co/{repo}/resolve/{revision}/{file}）
 */

import { join, normalize, sep, dirname } from "path"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { getPlatformPaths } from "../config/paths"

/** 嵌入模型（中文语义），transformers.js 生态的 ONNX 转换仓库 */
export const EMBEDDING_MODEL = "Xenova/bge-small-zh-v1.5"

/** 嵌入模型量化方式：q8 → onnx/model_quantized.onnx（约 24MB） */
export const EMBEDDING_DTYPE = "q8"

/** transformers.js env 的最小形状（避免依赖第三方不完善类型） */
export interface TransformersEnvLike {
  localModelPath: string
  cacheDir: string
  useCustomCache?: boolean
  customCache?: unknown
}

/** 判断 key 是否为本地绝对路径（Windows 盘符 / POSIX 根） */
function isAbsolutePath(key: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(key) || key.startsWith("/") || key.startsWith("\\")
}

/** 从远程 URL 提取 {repo}/{file} 相对路径 */
function urlToRelative(url: string): string {
  // https://huggingface.co/{repo_id}/resolve/{revision}/{file}，repo_id 可含多级路径
  const m = url.match(/^https?:\/\/[^/]+\/(.+)\/resolve\/[^/]+\/(.+)$/)
  return m ? `${m[1]}/${m[2]}` : ""
}

/** Web Cache API 兼容的缓存实现（Node fs 后端） */
export class FileSystemCache {
  /** 本地模型打包目录（优先读取，只读） */
  private modelDir = ""
  /** 下载缓存目录（读写，持久化在线下载的模型文件） */
  private cacheDir = ""

  constructor(modelDir: string, cacheDir: string) {
    this.modelDir = modelDir
    this.cacheDir = cacheDir
  }

  /** 读取本地文件，返回 Uint8Array 或 null（多候选目录） */
  private readLocal(relative: string): Uint8Array | null {
    for (const root of [this.modelDir, this.cacheDir]) {
      if (!root || !relative) continue
      const full = normalize(join(root, relative.split(sep).join(sep)))
      try {
        if (existsSync(full)) return new Uint8Array(readFileSync(full))
      } catch { /* 静默 */ }
    }
    return null
  }

  /** Web Cache API: match */
  // eslint-disable-next-line @typescript-eslint/require-await -- Cache API 要求 async 签名，实现为同步文件读取
  async match(key: string): Promise<unknown> {
    try {
      const k = String(key)
      let data: Uint8Array | null = null

      // 本地绝对路径：{localModelPath}/{repo}/{file}，直接读取该路径
      if (isAbsolutePath(k)) {
        try {
          if (existsSync(normalize(k))) data = new Uint8Array(readFileSync(normalize(k)))
        } catch { /* 静默 */ }
      }

      // 未命中时，按相对路径从打包目录 / 缓存目录读取
      if (!data) {
        const relative = isAbsolutePath(k) ? k.replace(/^[a-zA-Z]:[\\/]/, "").replace(/^[/\\]+/, "") : urlToRelative(k)
        data = this.readLocal(relative)
      }

      return data ? new Response(data) : undefined
    } catch { /* 静默 */ }
    return undefined
  }

  /** Web Cache API: put */
  async put(key: string, response: unknown): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Response 由 transformers.js 传入
      const body = await (response as Response).arrayBuffer()
      const k = String(key)
      // 只持久化远程下载的文件到缓存目录；本地绝对路径本身已在打包目录，无需写盘
      const relative = urlToRelative(k)
      if (!relative) return
      const full = normalize(join(this.cacheDir, relative))
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, new Uint8Array(body))
    } catch { /* 静默 */ }
  }
}

/**
 * 配置 Transformers.js 环境：
 *  - localModelPath：打包/预置模型目录（customCache 兜底读取）
 *  - cacheDir：下载缓存目录（customCache 写盘 + 二次启动读取）
 *  - customCache：Node fs 后端缓存，绕过 alpha 版本 useFS=false 缺陷
 */
export async function configureTransformersEnv(): Promise<void> {
  const mod = (await import("@huggingface/transformers")) as unknown as {
    env: TransformersEnvLike
  }
  const env = mod.env
  const { modelDir, userData } = getPlatformPaths()
  const cacheDir = join(userData, "models-cache")

  // 兜底 localModelPath（customCache 优先，双保险）
  if (modelDir) env.localModelPath = modelDir
  env.cacheDir = cacheDir

  // 启用自定义缓存：match 读打包目录 + 缓存目录，put 持久化下载文件
  env.useCustomCache = true
  env.customCache = new FileSystemCache(modelDir, cacheDir)
}
