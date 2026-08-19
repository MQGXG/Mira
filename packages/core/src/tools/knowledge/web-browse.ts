/**
 * Web Browse 工具 — 浏览器自动化 + 页面内容捕获
 * 使用 Playwright Chromium 驱动真实浏览器
 *
 * 支持操作：
 * - navigate/snapshot/click/type/scroll/back/extract（原有）
 * - capture（新增）— 截图 + Markdown + 图片 + 文档
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { getSharedContext, getPageText, extractImages, extractDocuments } from "./playwright-shared"
import TurndownService from "turndown"

let turndown: TurndownService | null = null
function getTurndown(): TurndownService {
  if (!turndown) turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
  return turndown
}

const navigationState = {
  currentUrl: "",
  history: [] as string[],
  historyIndex: -1,
}

export const webBrowseTool = make({
  name: "web_browse",
  description: "Open a web page and extract content. Supports navigation, snapshot, click, type, scroll, back, extract, and capture (full page capture with screenshot + Markdown + images + documents). Requires Playwright (npx playwright install chromium).",
  inputSchema: z.object({
    action: z.enum(["navigate", "snapshot", "click", "type", "scroll", "back", "extract", "capture"])
      .describe("操作: capture = 截图 + Markdown + 图片 + 文档"),
    url: z.string().optional().describe("navigate/capture 时所需 URL"),
    selector: z.string().optional().describe("click/type 时所需 CSS 选择器"),
    text: z.string().optional().describe("type 时输入的文本"),
    direction: z.enum(["up", "down"]).optional().default("down"),
    amount: z.number().optional().default(500),
    fullPage: z.boolean().optional().default(true).describe("capture 时是否全页截图"),
  }),
  outputSchema: z.string(),
  permission: "web_search",
  execute: async (input) => {
    let ctx
    try {
      ctx = await getSharedContext()
    } catch (e: any) {
      return { success: false, error: `浏览器启动失败: ${e.message}\n请确保已安装 Playwright: npx playwright install chromium` }
    }

    const page = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage()

    try {
      switch (input.action) {
        // ─── navigate ─────────────────────────────────
        case "navigate": {
          if (!input.url) return { success: false, error: "navigate 需要 url 参数" }
          await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 })
          navigationState.currentUrl = page.url()
          navigationState.history.push(navigationState.currentUrl)
          navigationState.historyIndex = navigationState.history.length - 1
          const title = await page.title()
          const text = await getPageText(page, 3000)
          return { success: true, output: `**${title}**\n\n${text}\n\nURL: ${page.url()}` }
        }

        // ─── snapshot ─────────────────────────────────
        case "snapshot": {
          const title = await page.title()
          const text = await getPageText(page, 4000)
          return { success: true, output: `**${title}**\n\n${text}\n\nURL: ${page.url()}` }
        }

        // ─── click ────────────────────────────────────
        case "click": {
          if (!input.selector) return { success: false, error: "click 需要 selector 参数" }
          await page.click(input.selector, { timeout: 5000 })
          await page.waitForTimeout(1000)
          const text = await getPageText(page, 3000)
          return { success: true, output: `已点击 ${input.selector}\n\n${text}` }
        }

        // ─── type ─────────────────────────────────────
        case "type": {
          if (!input.selector) return { success: false, error: "type 需要 selector 参数" }
          await page.fill(input.selector, input.text || "")
          return { success: true, output: `已在 ${input.selector} 输入文本` }
        }

        // ─── scroll ───────────────────────────────────
        case "scroll": {
          const dir = input.direction || "down"
          const amt = input.amount || 500
          await page.evaluate(({ direction, amount }) => window.scrollBy(0, direction === "down" ? amount : -amount), { direction: dir, amount: amt })
          await page.waitForTimeout(500)
          const text = await getPageText(page, 2000)
          return { success: true, output: `已${dir === "down" ? "向下" : "向上"}滚动\n\n${text}` }
        }

        // ─── back ─────────────────────────────────────
        case "back": {
          if (navigationState.historyIndex > 0) {
            navigationState.historyIndex--
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 })
          }
          const text = await getPageText(page, 3000)
          return { success: true, output: `已返回上一页\n\n${text}` }
        }

        // ─── extract ──────────────────────────────────
        case "extract": {
          const text = await getPageText(page, 5000)
          const links = await page.$$eval("a[href]", (els) =>
            els.slice(0, 20).map((a) => ({ text: a.textContent?.trim() || "", href: (a as HTMLAnchorElement).href }))
          )
          return { success: true, output: `${text}\n\n**链接:**\n${links.map((l) => `- [${l.text}](${l.href})`).join("\n")}` }
        }

        // ─── capture（新增）────────────────────────────
        case "capture": {
          // 如果提供了 url 且与当前页面不同，先导航
          if (input.url && input.url !== page.url()) {
            await page.goto(input.url, { waitUntil: "networkidle", timeout: 30000 })
            navigationState.currentUrl = page.url()
            navigationState.history.push(navigationState.currentUrl)
            navigationState.historyIndex = navigationState.history.length - 1
          }

          const title = await page.title()

          // 1. 提取正文 → Turndown → Markdown
          const html = await page.content()
          const markdown = getTurndown().turndown(html).slice(0, 50000)

          // 2. 截图
          const screenshotBuffer = await page.screenshot({
            fullPage: input.fullPage ?? true,
            type: "jpeg",
            quality: 80,
          })
          const screenshotBase64 = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`

          // 3. 提取图片
          const images = await extractImages(page, 30)

          // 4. 提取文档
          const documents = await extractDocuments(page)

          // 构建输出
          const imgLines = images.length > 0
            ? `\n\n**页面图片 (${images.length}):**\n${images.slice(0, 10).map(i => `- ${i.alt ? `${i.alt}: ` : ""}${i.url}`).join("\n")}${images.length > 10 ? `\n... 还有 ${images.length - 10} 张` : ""}`
            : ""

          const docLines = documents.length > 0
            ? `\n\n**文档链接 (${documents.length}):**\n${documents.map(d => `- [${d.title || d.url}](${d.url}) [${d.type}]`).join("\n")}`
            : ""

          const output = [
            `**${title}**`,
            `URL: ${page.url()}`,
            "",
            markdown.slice(0, 30000),
            imgLines,
            docLines,
          ].join("\n")

          return {
            success: true,
            output: output || "(empty content)",
            metadata: {
              url: page.url(),
              title,
              screenshot: screenshotBase64,
              images,
              documents,
              textLength: markdown.length,
              screenshotSize: screenshotBuffer.length,
            },
          }
        }

        default:
          return { success: false, error: `未知操作: ${input.action}` }
      }
    } catch (e) {
      const err = e as { message?: string }
      return { success: false, error: `操作失败: ${(err.message ?? String(e)).slice(0, 200)}` }
    }
  },
})
