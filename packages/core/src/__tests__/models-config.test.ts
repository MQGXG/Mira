import { describe, expect, test } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadUserModelConfig, getGlobalModelConfigPath } from '../config/models-config'

function tmpFile(name: string, content: string): string {
  const f = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(f, content)
  return f
}

describe('loadUserModelConfig', () => {
  test('文件不存在返回空配置（不抛错）', () => {
    const cfg = loadUserModelConfig(path.join(os.tmpdir(), 'definitely-nonexistent-models.json'))
    expect(cfg.providers).toEqual([])
    expect(cfg.overrides).toEqual({})
  })

  test('解析失败返回空配置（不抛错）', () => {
    const f = tmpFile('bad', 'not json{{{')
    const cfg = loadUserModelConfig(f)
    expect(cfg.providers).toEqual([])
    fs.unlinkSync(f)
  })

  test('解析合法配置（providers + overrides）', () => {
    const f = tmpFile('good', JSON.stringify({
      providers: [
        {
          id: 'mimo', label: 'Mimo', protocol: 'openai', authType: 'apiKey',
          models: [{ id: 'mimo-v2.5', label: 'Mimo 2.5', capabilities: ['vision'] }],
        },
      ],
      overrides: { openai: { baseUrl: 'https://custom.openai.com' } },
    }))
    const cfg = loadUserModelConfig(f)
    expect(cfg.providers!.length).toBe(1)
    expect(cfg.providers![0].id).toBe('mimo')
    expect(cfg.providers![0].models[0].capabilities).toContain('vision')
    expect(cfg.overrides!.openai.baseUrl).toBe('https://custom.openai.com')
    fs.unlinkSync(f)
  })

  test('非法 provider 定义被过滤（缺 id/label/protocol/models）', () => {
    const f = tmpFile('filter', JSON.stringify({
      providers: [
        { id: 'bad' },
        { id: 'ok', label: 'Ok', protocol: 'openai', authType: 'apiKey', models: [] },
      ],
    }))
    const cfg = loadUserModelConfig(f)
    expect(cfg.providers!.length).toBe(1)
    expect(cfg.providers![0].id).toBe('ok')
    fs.unlinkSync(f)
  })

  test('全局路径与 agents 目录同根', () => {
    expect(getGlobalModelConfigPath()).toContain('.config')
    expect(getGlobalModelConfigPath()).toContain('mira')
    expect(getGlobalModelConfigPath().endsWith('models.json')).toBe(true)
  })
})