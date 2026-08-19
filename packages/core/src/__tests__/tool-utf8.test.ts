/**
 * 工具 seam 迁移后写入验证
 * 验证：create_webpage / 核心工具经 getFs() 写入后 utf-8 编码正确（中文不乱码）
 */

import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { createWebpageTool } from "../tools/core/create-webpage"
import { writeFileTool } from "../tools/core/write-file"

let ws: string
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "mira-utf8-"))
})

const toolCtx = (workspace: string) => ({ workspace, sessionID: "s-utf8", mode: "assistant", agent: "build" } as never)

describe("工具 seam 写入编码", () => {
  it("create_webpage 写入含中文 HTML → utf-8 读回无乱码", async () => {
    const r = await createWebpageTool.execute(
      { path: "page.html", title: "测试页", body: "<h1>你好，世界！</h1><p>中文内容 🎉</p>" },
      toolCtx(ws),
    )
    expect(r.success).toBe(true)
    const file = path.join(ws, "page.html")
    const buf = fs.readFileSync(file)
    const text = buf.toString("utf-8")
    expect(text).toContain("你好，世界！")
    expect(text).toContain("中文内容")
    // 非 utf-8 解码应乱码（证明是 utf-8 写入而非 latin1）
    expect(buf.toString("latin1")).not.toContain("你好，世界！")
  })

  it("write_file 写入中文 → utf-8 读回一致（BOM 逻辑保留）", async () => {
    const content = "function greet() { return '你好' }\n// 注释：测试 🚀"
    const r = await writeFileTool.execute({ path: "app.js", content }, toolCtx(ws))
    expect(r.success).toBe(true)
    const read = fs.readFileSync(path.join(ws, "app.js"), "utf-8")
    expect(read).toBe(content)
    expect(read).toContain("你好")
  })
})
