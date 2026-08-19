/**
 * 第三方模块类型声明（Electron 主进程）
 * 编译 core 源码时需要以下模块声明：
 * - `diff`（jsdiff）：exports 类型解析失败，此处兜底
 * - `@huggingface/transformers`：包顶层 types 未被 exports 声明
 * - `turndown`：npm 无 @types/turndown 官方包
 */

declare module "diff" {
  export interface Change {
    value: string
    added?: boolean
    removed?: boolean
    count?: number
  }

  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string

  export function diffLines(oldStr: string, newStr: string, options?: Record<string, unknown>): Change[]
  export function diffWords(oldStr: string, newStr: string, options?: Record<string, unknown>): Change[]
  export function diffChars(oldStr: string, newStr: string, options?: Record<string, unknown>): Change[]
}

declare module "@huggingface/transformers" {
  export type TaskType = string
  export interface PipelineOptions {
    dtype?: string
    device?: string
    progress_callback?: (progress: unknown) => void
  }

  export function pipeline(
    task: TaskType,
    model?: string | null,
    options?: PipelineOptions,
  ): Promise<unknown>
}

declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "atx" | "setext"
    codeBlockStyle?: "indented" | "fenced"
    emDelimiter?: string
    strongDelimiter?: string
    linkStyle?: "inlined" | "referenced"
    bulletListMarker?: string
    hr?: string
    [key: string]: unknown
  }

  interface TurndownRule {
    filter: string | string[] | ((node: unknown) => boolean)
    replacement: (content: string, node: unknown, options: unknown) => string
  }

  class TurndownService {
    constructor(options?: TurndownOptions)
    use(plugin: unknown): TurndownService
    addRule(key: string, rule: TurndownRule): TurndownService
    remove(filter: string | string[] | ((node: unknown) => boolean)): TurndownService
    turndown(html: string | Node): string
  }

  export default TurndownService
}
