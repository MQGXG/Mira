/**
 * 缺失类型声明的第三方模块 ambient 声明
 *
 * diff / turndown 包未提供内置类型且无官方 @types；
 * @huggingface/transformers 的 types 未通过 package.json exports 暴露。
 * 此处提供最小可用声明，保证类型安全同时不影响运行时。
 */

declare module "diff" {
  export interface DiffOptions {
    context?: number
    ignoreWhitespace?: boolean
  }

  export interface DiffPart {
    value: string
    added?: boolean
    removed?: boolean
    count?: number
  }

  export function diffLines(oldStr: string, newStr: string, options?: DiffOptions): DiffPart[]
  export function diffWords(oldStr: string, newStr: string, options?: DiffOptions): DiffPart[]
  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: DiffOptions,
  ): string
  export function createPatch(fileName: string, oldStr: string, newStr: string, oldHeader?: string, newHeader?: string, options?: DiffOptions): string
  export function applyPatch(source: string, patch: string, options?: Record<string, unknown>): string
}

declare module "turndown" {
  interface TurndownServiceOptions {
    headingStyle?: "setext" | "atx"
    hr?: string
    bulletListMarker?: string
    codeBlockStyle?: "indented" | "fenced"
    fence?: string
    emDelimiter?: string
    strongDelimiter?: string
    linkStyle?: "inlined" | "referenced"
    linkReferenceStyle?: "full" | "collapsed" | "shortcut"
    br?: string
    blankReplacement?: (...args: unknown[]) => string
    keepReplacement?: (...args: unknown[]) => string
    defaultReplacement?: (...args: unknown[]) => string
    [key: string]: unknown
  }

  interface TurndownService {
    turndown(html: string | Node): string
    addRule(key: string, rule: unknown): this
    keep(filter: unknown): this
    remove(filter: unknown): this
    use(plugin: unknown): this
  }

  class TurndownService {
    constructor(options?: TurndownServiceOptions)
    turndown(html: string | Node): string
    addRule(key: string, rule: unknown): this
    keep(filter: unknown): this
    remove(filter: unknown): this
    use(plugin: unknown): this
  }

  export default TurndownService
}

declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model?: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}
