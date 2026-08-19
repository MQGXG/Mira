import { describe, expect, test } from 'vitest'
import { filterMainContent } from '../tools/knowledge/content-filter'

describe('filterMainContent', () => {
  test('移除 nav/footer/header 噪音', () => {
    const html = `<html><body>
      <nav>首页 关于 联系我们</nav>
      <header>网站标题</header>
      <article>
        <h1>正文标题</h1>
        <p>这是一段很长的正文内容，包含足够多的文字信息用于评分，这段文字会保留下来。</p>
      </article>
      <footer>版权所有 2026</footer>
    </body></html>`
    const out = filterMainContent(html)
    expect(out).not.toContain('nav>')
    expect(out).not.toContain('footer>')
    expect(out).not.toContain('header>')
    expect(out).toContain('正文标题')
  })

  test('移除广告/侧边栏（class 命中）', () => {
    const html = `<html><body>
      <div class="ad">广告内容广告内容广告内容广告内容广告内容</div>
      <div class="sidebar">侧边栏侧边栏侧边栏</div>
      <main>
        <p>主要正文内容主要正文内容主要正文内容主要正文内容主要正文内容主要正文内容</p>
      </main>
    </body></html>`
    const out = filterMainContent(html)
    expect(out).not.toContain('class="ad"')
    expect(out).not.toContain('sidebar')
    expect(out).toContain('主要正文')
  })

  test('保留 pre/code 代码块', () => {
    const html = `<html><body>
      <pre><code>const x = 1;
function foo() { return x; }</code></pre>
      <p>说明文字说明文字说明文字说明文字说明文字</p>
    </body></html>`
    const out = filterMainContent(html)
    expect(out).toContain('function foo')
  })

  test('过滤后为空则回退原始 HTML', () => {
    const html = `<html><body><script>alert(1)</script><div>hi</div></body></html>`
    expect(filterMainContent(html)).toBe(html)
  })

  test('enabled=false 直接返回原始', () => {
    const html = '<html><body><nav>x</nav></body></html>'
    expect(filterMainContent(html, { enabled: false })).toBe(html)
  })

  test('畸形 HTML 不抛异常', () => {
    expect(() => filterMainContent('<div><p>未闭合')).not.toThrow()
    expect(() => filterMainContent('')).not.toThrow()
  })
})
