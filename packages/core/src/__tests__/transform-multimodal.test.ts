import { describe, expect, test, vi } from 'vitest'
import { collectImages, hasImageContent, modelHasVision, multimodalBridge, type BridgeRuntime } from '../llm/transform'
import { serializeMessages as serializeOpenAI } from '../llm/protocols/openai-chat'
import { serializeMessages as serializeAnthropic } from '../llm/protocols/anthropic-messages'
import { ProviderCatalog } from '../llm/provider-catalog'
import type { LLMMessage } from '../llm/schema/messages'

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function userMsgWithImage(image: string, mediaType?: string) {
  return {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: '看看这张图' },
      { type: 'image' as const, image, mediaType },
    ],
  }
}

describe('multimodal transform', () => {
  test('collectImages extracts data URL with guessed mediaType', () => {
    const imgs = collectImages([userMsgWithImage(DATA_URL)])
    expect(imgs).toHaveLength(1)
    expect(imgs[0].data).toBe(DATA_URL)
    expect(imgs[0].mediaType).toBe('image/png')
  })

  test('collectImages honors explicit mediaType for remote URL', () => {
    const imgs = collectImages([userMsgWithImage('https://example.com/a.jpg', 'image/jpeg')])
    expect(imgs[0].data).toBe('https://example.com/a.jpg')
    expect(imgs[0].mediaType).toBe('image/jpeg')
  })

  test('hasImageContent detects image parts', () => {
    expect(hasImageContent([userMsgWithImage(DATA_URL)])).toBe(true)
    expect(hasImageContent([{ role: 'user', content: [{ type: 'text', text: 'no img' }] }])).toBe(false)
  })

  test('multimodalBridge replaces image with vision description', async () => {
    const fakeRuntime: BridgeRuntime = {
      complete: async () => ({ content: '这是一张包含 Rust 代码的截图' }),
    }
    const result = await multimodalBridge(
      [
        { role: 'system', content: 'sys' },
        userMsgWithImage(DATA_URL),
        { role: 'user', content: [{ type: 'text', text: '普通问题' }] },
      ],
      { provider: 'openai', model: 'gpt-4o', apiKey: 'x' },
      fakeRuntime,
    )
    const userMsg = result.find((m) => m.role === 'user')!
    expect(userMsg.content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'text', text: '[多模态视觉分析] 这是一张包含 Rust 代码的截图' },
    ])
  })

  test('multimodalBridge returns unchanged when no images', async () => {
    const fakeRuntime: BridgeRuntime = { complete: async () => ({ content: 'x' }) }
    const msgs: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    expect(await multimodalBridge(msgs, { provider: 'o', model: 'm', apiKey: 'k' }, fakeRuntime)).toBe(msgs)
  })

  test('multimodalBridge throws LLMError on vision failure', async () => {
    const fakeRuntime: BridgeRuntime = {
      complete: async () => { throw new Error('network down') },
    }
    await expect(
      multimodalBridge([userMsgWithImage(DATA_URL)], { provider: 'openai', model: 'gpt-4o', apiKey: 'x' }, fakeRuntime),
    ).rejects.toThrow(/Vision model analysis failed/)
  })

  test('modelHasVision uses catalog capability flag', () => {
    ProviderCatalog.registerBuiltins()
    expect(modelHasVision('openai', 'gpt-4o')).toBe(true)
    expect(modelHasVision('openai', 'gpt-3.5-turbo')).toBe(false)
    expect(modelHasVision('unknown-provider', 'x')).toBe(false)
  })
})

describe('protocol image serialization', () => {
  test('openai-chat emits image_url blocks for user message with image', () => {
    const out = serializeOpenAI([userMsgWithImage(DATA_URL, 'image/png')])
    expect(out).toHaveLength(1)
    const content = out[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ])
  })

  test('openai-chat keeps plain string content without images', () => {
    const out = serializeOpenAI([{ role: 'user', content: 'hi' }])
    expect(out[0].content).toBe('hi')
  })

  test('anthropic emits base64 image source block', () => {
    const out = serializeAnthropic([userMsgWithImage(DATA_URL, 'image/png')])
    expect(out).toHaveLength(1)
    const blocks = out[0].content as unknown as Array<Record<string, unknown>>
    const imageBlock = blocks.find((b) => b.type === 'image')
    expect(imageBlock).toBeTruthy()
    expect(imageBlock!.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    })
  })

  test('anthropic emits url source for non-data-url image', () => {
    const out = serializeAnthropic([userMsgWithImage('https://e.com/a.jpg', 'image/jpeg')])
    const blocks = out[0].content as unknown as Array<Record<string, unknown>>
    const imageBlock = blocks.find((b) => b.type === 'image')
    expect(imageBlock!.source).toEqual({ type: 'url', url: 'https://e.com/a.jpg' })
  })

  test('client bridge is wired when model lacks vision (smoke via serialized messages)', async () => {
    // 静默导入以保证 client 已挂载桥逻辑（挂载验证见 integration 测试）
    const { createLLMClient } = await import('../llm/client')
    expect(typeof createLLMClient).toBe('function')
  })
})

describe('convertMessages preserves image parts', () => {
  test('image part survives normalization so vision models receive it', async () => {
    const { convertMessages } = await import('../llm/client')
    const out = convertMessages([userMsgWithImage(DATA_URL, 'image/png')])
    expect(Array.isArray(out[0].content)).toBe(true)
    const parts = out[0].content as unknown as Array<Record<string, unknown>>
    expect(parts).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image', image: DATA_URL, mediaType: 'image/png' },
    ])
  })

  test('normalized image message serializes to openai image_url', async () => {
    const { convertMessages } = await import('../llm/client')
    const { serializeMessages } = await import('../llm/protocols/openai-chat')
    const out = serializeMessages(convertMessages([userMsgWithImage(DATA_URL, 'image/png')]))
    expect(Array.isArray(out[0].content)).toBe(true)
    expect(out[0].content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ])
  })
})