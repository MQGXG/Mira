/**
 * 图片生成工具 — 调用 OpenAI DALL-E 或其他 API 生成图片
 */

import { z } from "zod"
import { make } from "../../shared/tool"

export const imageGenTool = make({
  name: "image_generate",
  description: "根据文本描述生成图片。使用 DALL-E 或兼容 API",
  inputSchema: z.object({
    prompt: z.string().describe("图片描述（英文效果更好）"),
    size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional().default("1024x1024").describe("图片尺寸"),
    quality: z.enum(["standard", "hd"]).optional().default("standard").describe("图片质量"),
  }),
  outputSchema: z.string(),
  execute: async (input, ctx) => {
    try {
      // 从 context 中获取 API 配置（通过 workspace 传递的配置）
      const { sessionID, workspace } = ctx

      // 尝试调用 OpenAI DALL-E API
      const apiKey = process.env.OPENAI_API_KEY || ""
      if (!apiKey) {
        return { success: false, error: "未配置 API Key。请在设置中填入 OpenAI API Key 以使用图片生成功能" }
      }

      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: input.prompt,
          n: 1,
          size: input.size || "1024x1024",
          quality: input.quality || "standard",
        }),
        signal: AbortSignal.timeout(60000),
      })

      if (!resp.ok) {
        const text = await resp.text()
        return { success: false, error: `图片生成 API 错误: ${text.slice(0, 200)}` }
      }

      const data = await resp.json()
      const imageUrl = data.data?.[0]?.url
      const revisedPrompt = data.data?.[0]?.revised_prompt

      if (!imageUrl) {
        return { success: false, error: "API 返回未包含图片 URL" }
      }

      const output = [`![生成的图片](${imageUrl})`]
      if (revisedPrompt) {
        output.push(`\n\n*AI 优化后的提示词: ${revisedPrompt}*`)
      }

      return { success: true, output: output.join("\n") }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

