import * as dns from "dns"
import { URL } from "url"

/** IPv4 私有/保留段（含 link-local 与 CGNAT） */
const IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 当前网络
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let int = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    int = (int << 8) | n
  }
  return int >>> 0
}

function isPrivateIPv4(ip: string): boolean {
  const int = ipv4ToInt(ip)
  if (int === null) return false
  return IPV4_RANGES.some(([start, end]) => int >= start && int <= end)
}

/** 解析 IPv6（含 IPv4 内嵌形式）为 8 个 16 位组；无法解析返回 null */
function parseIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase()
  const pct = addr.indexOf("%")
  if (pct !== -1) addr = addr.slice(0, pct)

  // IPv4-mapped: ::ffff:a.b.c.d
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const int = ipv4ToInt(mapped[1])
    if (int === null) return null
    return [0, 0, 0, 0, 0, 0xffff, (int >>> 16) & 0xffff, int & 0xffff]
  }

  // 内嵌 IPv4 尾部: ...:a.b.c.d
  const v4Tail = addr.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Tail) {
    const int = ipv4ToInt(v4Tail[2])
    if (int === null) return null
    addr = `${v4Tail[1]}:${((int >>> 16) & 0xffff).toString(16)}:${(int & 0xffff).toString(16)}`
  }

  let groups: number[] | null = null
  if (addr.includes("::")) {
    const [l, r] = addr.split("::")
    const left = l ? l.split(":").filter(Boolean).map((g) => parseInt(g, 16)) : []
    const right = r ? r.split(":").filter(Boolean).map((g) => parseInt(g, 16)) : []
    const missing = 8 - left.length - right.length
    if (missing < 0 || left.some(Number.isNaN) || right.some(Number.isNaN)) return null
    groups = [...left, ...Array(missing).fill(0), ...right]
  } else {
    const gs = addr.split(":").filter(Boolean).map((g) => parseInt(g, 16))
    if (gs.length === 8 && !gs.some(Number.isNaN)) groups = gs
  }
  if (!groups) return null
  return groups
}

function isPrivateIPv6(ip: string): boolean {
  const g = parseIPv6(ip)
  if (!g) return false
  const [a, b, c, d, e, f, g7, g8] = g

  // loopback ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g7 === 0 && g8 === 1) return true

  // IPv4-mapped: 0:0:0:0:0:ffff:x → 按内嵌 IPv4 判定
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    const v4 = (((g7 << 16) | g8) >>> 0)
    return IPV4_RANGES.some(([start, end]) => v4 >= start && v4 <= end)
  }

  // ULA fc00::/7
  if (a >= 0xfc00 && a <= 0xfdff) return true
  // link-local fe80::/10
  if (a >= 0xfe80 && a <= 0xfebf) return true
  return false
}

/** 判定 IP 是否为私有/保留/内网地址（IPv4 + IPv6） */
export function isPrivateIP(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/%[^:]*$/, "")
  if (addr.includes(":")) {
    // IPv4-mapped 字面量（::ffff:192.168.1.1）
    if (isPrivateIPv4(addr) || isPrivateIPv6(addr)) return true
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateIPv4(mapped[1]) : false
  }
  return isPrivateIPv4(addr)
}

/** SSRF 防护：检查 URL 的目标 IP 是否为私有内网地址 */
export async function assertSafeUrl(urlStr: string): Promise<void> {
  const url = new URL(urlStr)
  let hostname = url.hostname
  // 去除 IPv6 方括号
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1)
  }

  // 本地主机名直接拒绝
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
    throw new Error(`SSRF blocked: localhost address (${hostname})`)
  }

  // 字面量 IP 直接检查
  if (isPrivateIP(hostname)) {
    throw new Error(`SSRF blocked: private IP address (${hostname})`)
  }

  // 主机名 → DNS 解析（A + AAAA）并逐一检查
  const addresses = await new Promise<string[]>((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      resolve(err || !addrs ? [] : addrs.map((a) => a.address))
    })
  })

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new Error(`SSRF blocked: private IP address (${addr}) for ${hostname}`)
    }
  }
}
