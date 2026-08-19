import { describe, expect, test, it, vi, beforeEach } from 'vitest'
import { assertSafeUrl, isPrivateIP } from '../tools/knowledge/ssrf-util'

const current = { a: [] as string[], aaaa: [] as string[] }

vi.mock('dns', () => ({
  lookup: (_h: string, _o: any, cb: any) => {
    const addrs = []
    for (const a of current.a) addrs.push({ address: a, family: 4 })
    for (const a of current.aaaa) addrs.push({ address: a, family: 6 })
    cb(null, addrs)
  },
}))

beforeEach(() => {
  current.a = []
  current.aaaa = []
})

function mockA(ips: string[]) {
  current.a = ips
  current.aaaa = []
}
function mockAAAA(ips: string[]) {
  current.aaaa = ips
  current.a = []
}

describe('isPrivateIP', () => {
  it('拦截 IPv4 私有段', () => {
    for (const ip of ['10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.1.100', '127.0.0.1', '0.0.0.0']) {
      expect(isPrivateIP(ip), ip).toBe(true)
    }
  })

  it('拦截 link-local 169.254.0.0/16 与 CGNAT 100.64.0.0/10', () => {
    expect(isPrivateIP('169.254.169.254')).toBe(true)
    expect(isPrivateIP('169.254.0.1')).toBe(true)
    expect(isPrivateIP('100.64.0.1')).toBe(true)
    expect(isPrivateIP('100.127.255.255')).toBe(true)
  })

  it('放行公共 IPv4', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false)
    expect(isPrivateIP('93.184.216.34')).toBe(false)
  })

  it('拦截 IPv6 loopback / ULA / link-local', () => {
    expect(isPrivateIP('::1')).toBe(true)
    expect(isPrivateIP('fc00::1')).toBe(true)
    expect(isPrivateIP('fd12:3456:789a::1')).toBe(true)
    expect(isPrivateIP('fe80::1')).toBe(true)
  })

  it('拦截 IPv4-mapped IPv6', () => {
    expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true)
    expect(isPrivateIP('0000:0000:0000:0000:0000:ffff:192.168.1.1')).toBe(true)
  })

  it('放行公共 IPv6', () => {
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false)
  })
})

describe('assertSafeUrl DNS 解析防护', () => {
  it('hostname 解析到私有 IP 时被拦截', async () => {
    mockA(['10.0.0.2'])
    await expect(assertSafeUrl('http://private.example.com/')).rejects.toThrow(/SSRF blocked/)
    await expect(assertSafeUrl('http://private.example.com/')).rejects.toThrow(/10\.0\.0\.2/)
  })

  it('hostname 解析到 link-local 时被拦截', async () => {
    mockA(['169.254.169.254'])
    await expect(assertSafeUrl('http://metadata.example.com/latest/meta-data')).rejects.toThrow(/SSRF blocked/)
  })

  it('hostname 解析到 IPv6 私有地址时被拦截', async () => {
    mockAAAA(['fd00::1'])
    await expect(assertSafeUrl('http://ula.example.com/')).rejects.toThrow(/SSRF blocked/)
  })

  it('公共地址放行', async () => {
    mockA(['93.184.216.34'])
    await expect(assertSafeUrl('http://public.example.com/')).resolves.toBeUndefined()
  })

  it('解析失败时放行（无法判断则不过度阻断公网解析）', async () => {
    mockA([])
    await expect(assertSafeUrl('http://unknown.example.com/')).resolves.toBeUndefined()
  })
})