/**
 * Transformers.js 本地模型环境配置测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { FileSystemCache, EMBEDDING_MODEL, EMBEDDING_DTYPE } from "../memory/transformers-env"
import { initPlatformPaths } from "../config/paths"

describe("TransformersEnv", () => {
  let modelDir: string
  let cacheDir: string

  beforeEach(() => {
    modelDir = mkdtempSync(join(tmpdir(), "mira-models-"))
    cacheDir = mkdtempSync(join(tmpdir(), "mira-cache-"))
    initPlatformPaths({
      userData: process.cwd() + "/.test-data",
      home: process.env.HOME || process.env.USERPROFILE || "/tmp",
      modelDir,
    })
  })

  afterEach(() => {
    rmSync(modelDir, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it("should export the Chinese embedding model constant", () => {
    expect(EMBEDDING_MODEL).toBe("Xenova/bge-small-zh-v1.5")
    expect(EMBEDDING_DTYPE).toBe("q8")
  })

  it("should read bundled model files from the model directory", async () => {
    // 模拟打包模型：{modelDir}/{repo}/onnx/model_quantized.onnx
    const repoDir = join(modelDir, "Xenova", "bge-small-zh-v1.5", "onnx")
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, "model_quantized.onnx"), Buffer.from("FAKE-ONNX-DATA"))

    const cache = new FileSystemCache(modelDir, cacheDir)
    // transformers.js 以绝对本地路径请求（localModelPath 拼接）
    const absolute = join(modelDir, "Xenova", "bge-small-zh-v1.5", "onnx", "model_quantized.onnx")
    const resp = (await cache.match(absolute)) as Response
    expect(resp).toBeDefined()
    const body = await resp.arrayBuffer()
    expect(Buffer.from(body).toString()).toBe("FAKE-ONNX-DATA")
  })

  it("should read downloaded files from the cache directory by remote URL", async () => {
    // 模拟已下载缓存：{cacheDir}/{repo}/config.json
    const repoDir = join(cacheDir, "Xenova", "bge-small-zh-v1.5")
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, "config.json"), JSON.stringify({ mock: true }))

    const cache = new FileSystemCache(modelDir, cacheDir)
    const url = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/config.json`
    const resp = (await cache.match(url)) as Response
    expect(resp).toBeDefined()
    const body = JSON.parse(Buffer.from(await resp.arrayBuffer()).toString())
    expect(body.mock).toBe(true)
  })

  it("should persist downloaded files into the cache directory on put", async () => {
    const cache = new FileSystemCache(modelDir, cacheDir)
    const url = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/tokenizer.json`
    const resp = new Response(JSON.stringify({ token: "x" }))

    await cache.put(url, resp)

    const saved = join(cacheDir, EMBEDDING_MODEL, "tokenizer.json")
    expect(existsSync(saved)).toBe(true)
    expect(JSON.parse(readFileSync(saved, "utf-8")).token).toBe("x")
  })

  it("should prefer bundled model over cache when both exist", async () => {
    // 打包目录与缓存目录同时存在同名文件时，应命中打包目录
    const repoDirBundled = join(modelDir, "Xenova", "bge-small-zh-v1.5")
    mkdirSync(repoDirBundled, { recursive: true })
    writeFileSync(join(repoDirBundled, "config.json"), "bundled")

    const repoDirCache = join(cacheDir, "Xenova", "bge-small-zh-v1.5")
    mkdirSync(repoDirCache, { recursive: true })
    writeFileSync(join(repoDirCache, "config.json"), "cached")

    const cache = new FileSystemCache(modelDir, cacheDir)
    const url = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/config.json`
    const resp = (await cache.match(url)) as Response
    expect(Buffer.from(await resp.arrayBuffer()).toString()).toBe("bundled")
  })

  it("should return undefined when file is missing everywhere (triggers online download)", async () => {
    const cache = new FileSystemCache(modelDir, cacheDir)
    const url = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/missing.onnx`
    const resp = await cache.match(url)
    expect(resp).toBeUndefined()
  })
})
