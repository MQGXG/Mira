/**
 * 第三方模块类型声明
 *
 * - `diff`（jsdiff）：npm 未发布官方 @types/diff 时使用此声明（最新版已内置类型，
 *   此处仅为 exports/type 解析失败的兜底）
 * - `@huggingface/transformers`：包顶层有 types，但其 package.json "exports"
 *   未声明 types 条件，TS bundler/node16 解析失败，故在此显式声明动态导入的成员
 */

declare module "diff" {
  export interface Change {
    value: string
    added?: boolean
    removed?: boolean
    count?: number
  }

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
