import { describe, expect, test } from "vitest"
import { OpenAICompatibleChatProtocol } from "../llm/protocols/openai-compatible-chat"
import type { LLMMessage } from "../llm/schema"

describe("图片序列化回归（图片为何到不了模型）", () => {
  const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAA"

  function makeMessages(): LLMMessage[] {
    return [
      {
        role: "user",
        content: [
          { type: "text" as const, text: "请识别这张图片" },
          { type: "image" as const, image: imageDataUrl, mediaType: "image/png" },
        ],
      },
    ]
  }

  test("serializeRequest 生成的请求体包含完整 image_url", () => {
    const body = OpenAICompatibleChatProtocol.serializeRequest({
      model: "deepseek-v4-flash",
      messages: makeMessages(),
      tools: [],
    }) as { messages: Array<{ content: unknown }> }
    const content = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>
    expect(Array.isArray(content)).toBe(true)
    const imgPart = content.find((p) => p.type === "image_url")
    expect(imgPart).toBeDefined()
    expect(imgPart!.image_url!.url).toBe(imageDataUrl)
  })

  test("hasImageContent 能识别注入后的 image part", async () => {
    const { hasImageContent } = await import("../llm/transform")
    const { convertMessages } = await import("../llm/client")
    const converted = convertMessages(makeMessages())
    expect(hasImageContent(converted)).toBe(true)
  })
})

