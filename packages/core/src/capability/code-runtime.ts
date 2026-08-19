/**
 * Code-runtime seam (capability: "code-runtime")
 *
 * Service Definition: {@link CodeRuntimeProvider} — run a snippet of code in an
 * isolated temporary sandbox (Python or Node). Consumed by the run_code tool.
 * Service Provider: {@link LocalCodeRuntimeProvider} — default local implementation
 * writing to a temp dir and executing with the system runtime.
 */

import { execFile } from "child_process"
import { promisify } from "util"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as os from "os"
import { capabilityRegistry } from "./index"

export const CODE_RUNTIME_CAPABILITY = "code-runtime"

const execFileAsync = promisify(execFile)

/** 打包的 Office 库目录（docx/xlsx/pptxgenjs 及依赖树，动态脚本生成 Office 用） */
const OFFICE_LIBS_REL = path.join("office-libs", "node_modules")

/**
 * 定位 office-libs 的 node_modules：
 * 1) 打包资源 `process.resourcesPath/office-libs/node_modules`
 * 2) 开发环境：从当前文件向上找项目根的 `resources/office-libs/node_modules`
 */
function findOfficeLibsNodeModules(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const p = path.join(resourcesPath, OFFICE_LIBS_REL)
    if (fsSync.existsSync(p)) return p
  }
  let dir = __dirname
  for (;;) {
    const probe = path.join(dir, "resources", OFFICE_LIBS_REL)
    if (fsSync.existsSync(probe)) return probe
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 在临时脚本目录建 node_modules junction/symlink → office-libs，使 `import 'docx'` 可解析 */
async function linkOfficeLibs(tmpDir: string): Promise<void> {
  const libs = findOfficeLibsNodeModules()
  if (!libs) return
  const link = path.join(tmpDir, "node_modules")
  try {
    const type = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(libs, link, type)
  } catch {
    /* 已有 node_modules 或权限不足：忽略，脚本仍可零库运行 */
  }
}

export interface CodeRuntimeResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface CodeRuntimeRequest {
  code: string
  language: "python" | "node"
  timeoutMs?: number
}

export interface CodeRuntimeProvider {
  readonly name: string
  run(request: CodeRuntimeRequest): Promise<CodeRuntimeResult>
}

export class LocalCodeRuntimeProvider implements CodeRuntimeProvider {
  readonly name = "local"

  async run(request: CodeRuntimeRequest): Promise<CodeRuntimeResult> {
    const timeoutMs = request.timeoutMs ?? 30000
    const isNode = request.language === "node"
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mira-code-"))
    const filePath = path.join(tmpDir, isNode ? "script.mjs" : "script.py")
    try {
      await fs.writeFile(filePath, request.code, "utf-8")
      // Node 脚本注入打包的 Office 库（junction），使 ESM/CJS 均能 import docx/xlsx/pptxgenjs
      if (isNode) await linkOfficeLibs(tmpDir)
      const { stdout, stderr } = await execFileAsync(isNode ? process.execPath : "python", [filePath], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      })
      return { stdout, stderr, exitCode: 0 }
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; code?: number; message?: string }
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? String(e),
        exitCode: typeof err.code === "number" ? err.code : null,
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

const defaultCodeRuntimeProvider = new LocalCodeRuntimeProvider()

/** Get the active code-runtime provider (registered one or local default). */
export function getCodeRuntime(): CodeRuntimeProvider {
  return capabilityRegistry.get<CodeRuntimeProvider>(CODE_RUNTIME_CAPABILITY) ?? defaultCodeRuntimeProvider
}

export { defaultCodeRuntimeProvider }
