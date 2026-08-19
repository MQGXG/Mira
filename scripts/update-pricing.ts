/**
 * update-pricing — 从 models.dev 拉取模型定价，生成快照
 *
 * models.dev 数据单位：美元/百万 token。本脚本转换为美元/千 token，
 * 写入 packages/core/src/assets/models-pricing.json 供 cost.ts 读取。
 *
 * 运行：pnpm exec tsx scripts/update-pricing.ts
 * （需网络；生成后提交快照，运行时零网络依赖）
 */

import { writeFileSync } from "fs"
import { join } from "path"

const MODELS_DEV_URL = "https://models.dev/api.json"
const OUT_PATH = join(process.cwd(), "packages/core/src/assets/models-pricing.json")

interface ModelsDevEntry {
  id?: string
  pricing?: {
    input?: number
    output?: number
    cacheReadInput?: number | null
    cacheWriteInput?: number | null
  }
}

async function main(): Promise<void> {
  console.log(`Fetching ${MODELS_DEV_URL}...`)
  const res = await fetch(MODELS_DEV_URL)
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`)
  const data = (await res.json()) as Record<string, ModelsDevEntry>

  const snapshot: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {}
  for (const [id, entry] of Object.entries(data)) {
    const pricing = entry?.pricing
    if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") continue
    const item: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
      input: pricing.input / 1000,
      output: pricing.output / 1000,
    }
    if (typeof pricing.cacheReadInput === "number") item.cacheRead = pricing.cacheReadInput / 1000
    if (typeof pricing.cacheWriteInput === "number") item.cacheWrite = pricing.cacheWriteInput / 1000
    snapshot[id] = item
  }

  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8")
  console.log(`✅ 已生成 ${OUT_PATH}（${Object.keys(snapshot).length} 个模型）`)
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
