import type { BrowserContext, Page } from "playwright"

let browserContext: BrowserContext | null = null
let launchAttempted = false
let launchError = ""

export async function getSharedContext(): Promise<BrowserContext> {
  if (browserContext) return browserContext
  if (launchAttempted) throw new Error(launchError || "浏览器启动失败，请检查 Playwright 安装")
  launchAttempted = true

  try {
    const { chromium } = await import("playwright")
    const browser = await chromium.launch({ headless: true, timeout: 15000 })
    browserContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })
    return browserContext
  } catch (e: any) {
    launchError = e.message || String(e)
    if (launchError.includes("Cannot find module") || launchError.includes("playwright")) {
      launchError = "Playwright 未安装。请运行: npx playwright install chromium"
    } else if (launchError.includes("Executable doesn't exist") || launchError.includes("chromium")) {
      launchError = "Chromium 浏览器未下载。请运行: npx playwright install chromium"
    }
    throw new Error(launchError)
  }
}

export function getPageText(page: Page, maxLen = 4000): Promise<string> {
  return page.innerText("body").then(t => t.slice(0, maxLen)).catch(() => "(无法提取页面内容)")
}

/** 提取页面内图片 */
export async function extractImages(page: Page, max = 30): Promise<Array<{ url: string; alt: string; width: number; height: number }>> {
  return page.evaluate((m) => {
    const imgs = document.querySelectorAll("img")
    return Array.from(imgs).slice(0, m).map(img => ({
      url: (img).src || "",
      alt: (img).alt || "",
      width: (img).naturalWidth || img.clientWidth,
      height: (img).naturalHeight || img.clientHeight,
    })).filter(img => img.url.startsWith("http"))
  }, max)
}

/** 提取页面内文档链接 */
export async function extractDocuments(page: Page): Promise<Array<{ url: string; title: string; type: string }>> {
  const docExts = [".pdf", ".docx", ".doc", ".xlsx", ".pptx", ".csv"]
  return page.evaluate((exts) => {
    const links = document.querySelectorAll("a[href]")
    return Array.from(links).map(a => {
      const href = (a as HTMLAnchorElement).href
      const ext = exts.find(e => href.toLowerCase().includes(e))
      return { url: href, title: a.textContent?.trim() || "", type: ext ? ext.slice(1) : "other" }
    }).filter(d => d.url.startsWith("http") && exts.some(e => d.url.toLowerCase().includes(e)))
  }, docExts)
}
