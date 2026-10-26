/**
 * Skill 加载器 — 扫描和加载 Skill 目录
 * 参考 Hermes Agent skill 系统：~/.config/mira/skills/<category>/<skill>/SKILL.md
 * 兼容 OpenCode Agent Skills 标准：skills/<name>/SKILL.md（扁平结构），
 * 发现位置对齐 OpenCode：项目级 .opencode/.claude/.agents（向上遍历到 git 根）+ 全局 ~/.config/opencode、~/.claude、~/.agents
 */

import { join, dirname, resolve, sep } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"

/** Skill 来源标识（按扫描优先级从高到低） */
export type SkillSource =
  | "mira"            // ~/.config/mira/skills（内置，支持分类结构）
  | "user"            // 用户/插件注册的额外目录
  | "project-opencode"// {项目根}/.opencode/skills
  | "project-claude"  // {项目根}/.claude/skills
  | "project-agents"  // {项目根}/.agents/skills
  | "opencode"        // ~/.config/opencode/skills（全局兼容）
  | "claude"          // ~/.claude/skills（全局兼容）
  | "agents"          // ~/.agents/skills（全局兼容）

export interface SkillMeta {
  name: string
  description: string
  category: string | null
  path: string
  tags: string[]
  /** 来源标识（扫描根类型） */
  source: SkillSource
  /** 是否启用（skills.json disabled 名单之外） */
  enabled: boolean
}

export interface SkillContent {
  meta: SkillMeta
  content: string
  linkedFiles: string[]
}

/** 扫描选项 */
export interface ScanOptions {
  /** 项目级目录发现起点（workspace），向上遍历到 git 根 */
  workspace?: string
  /** 包含已禁用的 skill（设置页需要；默认 false 过滤） */
  includeDisabled?: boolean
}

/** 扫描根：目录 + 来源 */
interface SkillRoot {
  dir: string
  source: SkillSource
}

/** skills.json 持久化配置（用户添加目录 + 禁用名单） */
export interface SkillsConfig {
  extraDirs: string[]
  disabled: string[]
}

/** OpenCode Agent Skills 的 name 规范：小写字母数字 + 单连字符 */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 校验 skill name 是否符合 OpenCode 规范（1-64 字符，^[a-z0-9]+(-[a-z0-9]+)*$） */
export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_RE.test(name)
}

/** 获取内置 skills 根目录 */
export function getSkillsDir(): string {
  return join(getPlatformPaths().home, ".config", "mira", "skills")
}

/** 获取 skills.json 配置路径（用户添加目录 + 禁用名单的持久化位置） */
export function getSkillsConfigPath(): string {
  return join(getPlatformPaths().home, ".config", "mira", "skills.json")
}

/** 读取 skills.json（文件不存在/损坏时返回空配置，容错） */
export function readSkillsConfig(): SkillsConfig {
  try {
    const raw = fs.readFileSync(getSkillsConfigPath(), "utf-8")
    const parsed = JSON.parse(raw) as Partial<SkillsConfig>
    return {
      extraDirs: Array.isArray(parsed.extraDirs) ? parsed.extraDirs.filter((d) => typeof d === "string") : [],
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((d) => typeof d === "string") : [],
    }
  } catch {
    return { extraDirs: [], disabled: [] }
  }
}

/** 写入 skills.json（容错：目录不存在时自动创建） */
export function writeSkillsConfig(config: SkillsConfig): void {
  const path = getSkillsConfigPath()
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(config, null, 2), "utf-8")
}

/** 全局兼容目录（OpenCode / Claude / Agents 标准位置） */
export function getCompatGlobalSkillDirs(): Array<{ dir: string; source: SkillSource }> {
  const home = getPlatformPaths().home
  return [
    { dir: join(home, ".config", "opencode", "skills"), source: "opencode" },
    { dir: join(home, ".claude", "skills"), source: "claude" },
    { dir: join(home, ".agents", "skills"), source: "agents" },
  ]
}

/**
 * 项目级兼容目录：从 workspace 向上遍历到 git 根（对齐 OpenCode discovery）
 * 每层收集 .opencode/skills、.claude/skills、.agents/skills；遇到 .git 所在层处理完后停止
 */
export function getCompatProjectSkillDirs(workspace: string): Array<{ dir: string; source: SkillSource }> {
  const roots: Array<{ dir: string; source: SkillSource }> = []
  const seen = new Set<string>()
  let current = resolve(workspace)
  while (current && !seen.has(current)) {
    seen.add(current)
    roots.push(
      { dir: join(current, ".opencode", "skills"), source: "project-opencode" },
      { dir: join(current, ".claude", "skills"), source: "project-claude" },
      { dir: join(current, ".agents", "skills"), source: "project-agents" },
    )
    if (fs.existsSync(join(current, ".git"))) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

/**
 * 卸载（删除）指定 skill 的目录
 * 安全约束：skill 必须能被扫描发现；目标目录必须包含 SKILL.md（防止误删非 skill 目录）；
 * 删除后清理 skills.json 中该 skill 的禁用名单残留
 */
export function uninstallSkill(
  name: string,
  extraDirs: string[] = [],
  options: ScanOptions = {},
): { success: boolean; error?: string; path?: string } {
  const meta = scanSkills(extraDirs, { ...options, includeDisabled: true }).find((s) => s.name === name)
  if (!meta) return { success: false, error: `Skill '${name}' 未找到` }

  // 安全约束：目标目录必须含 SKILL.md（只允许删除真正的 skill 目录）
  if (!fs.existsSync(join(meta.path, "SKILL.md"))) {
    return { success: false, error: "目标目录不是有效的 skill 目录（缺少 SKILL.md）" }
  }

  try {
    fs.rmSync(meta.path, { recursive: true, force: false })
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }

  // 清理 skills.json disabled 名单残留（不清理 extraDirs——那是目录级注册）
  const cfg = readSkillsConfig()
  const idx = cfg.disabled.indexOf(name)
  if (idx >= 0) {
    cfg.disabled.splice(idx, 1)
    writeSkillsConfig(cfg)
  }

  return { success: true, path: meta.path }
}

/** 解析 SKILL.md 的 YAML frontmatter */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const lines = content.split("\n")
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content }

  const endIdx = lines.indexOf("---", 1)
  if (endIdx === -1) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, any> = {}
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i].trim()
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      // 处理列表值
      if (value.startsWith("[")) {
        frontmatter[key] = value.slice(1, -1).split(",").map((s) => s.trim().replace(/['"]/g, ""))
      } else {
        frontmatter[key] = value.replace(/^['"]|['"]$/g, "")
      }
    }
  }

  return { frontmatter, body: lines.slice(endIdx + 1).join("\n").trim() }
}

/** 读取单个 skill 目录的元数据（SKILL.md 必须存在），dirName 兜底 name */
function readSkillMeta(
  skillPath: string,
  dirName: string,
  category: string | null,
  source: SkillSource,
  disabled: ReadonlySet<string>,
): SkillMeta | null {
  try {
    const raw = fs.readFileSync(join(skillPath, "SKILL.md"), "utf-8")
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = String(frontmatter.name || dirName).slice(0, 64)
    const description = String(
      frontmatter.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || "",
    ).slice(0, 1024)
    return {
      name,
      description,
      category,
      path: skillPath,
      tags: (frontmatter.tags || frontmatter["metadata.hermes.tags"] || []) as string[],
      source,
      enabled: !disabled.has(name),
    }
  } catch {
    return null
  }
}

/** 安全列举目录（不存在/不可读返回空数组） */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** 安全判断目录（不存在/不可读返回 false） */
function isDir(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫描所有 skill 目录
 * 扫描根优先级：Mira 内置 → 传入 extraDirs（插件）→ skills.json 用户目录 → 项目级 → 全局兼容
 * 双结构识别：根下子目录直接含 SKILL.md 为扁平 skill（无分类）；否则再下探一层为分类 skill
 * 重名按扫描根优先级去重（首见者胜），默认过滤 disabled 名单中的 skill
 */
export function scanSkills(extraDirs: string[] = [], options: ScanOptions = {}): SkillMeta[] {
  const cfg = readSkillsConfig()
  const disabled = new Set(cfg.disabled)
  const roots: SkillRoot[] = [
    { dir: getSkillsDir(), source: "mira" },
    ...extraDirs.map((dir) => ({ dir, source: "user" as const })),
    // skills.json 用户目录（去重插件已传入的目录）
    ...cfg.extraDirs
      .filter((dir) => !extraDirs.includes(dir))
      .map((dir) => ({ dir, source: "user" as const })),
    ...(options.workspace ? getCompatProjectSkillDirs(options.workspace) : []),
    ...getCompatGlobalSkillDirs(),
  ]

  const results: SkillMeta[] = []
  const seenNames = new Set<string>()

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue

    for (const entry of safeReaddir(root.dir)) {
      const childPath = join(root.dir, entry)
      if (!isDir(childPath)) continue

      // 扁平结构：<root>/<name>/SKILL.md（OpenCode 标准）
      if (fs.existsSync(join(childPath, "SKILL.md"))) {
        const meta = readSkillMeta(childPath, entry, null, root.source, disabled)
        if (meta && !seenNames.has(meta.name)) {
          seenNames.add(meta.name)
          results.push(meta)
        }
        continue
      }

      // 分类结构：<root>/<category>/<name>/SKILL.md（Mira 传统结构）
      for (const sub of safeReaddir(childPath)) {
        const skillPath = join(childPath, sub)
        if (!isDir(skillPath)) continue
        if (!fs.existsSync(join(skillPath, "SKILL.md"))) continue
        const meta = readSkillMeta(skillPath, sub, entry === "_root" ? null : entry, root.source, disabled)
        if (meta && !seenNames.has(meta.name)) {
          seenNames.add(meta.name)
          results.push(meta)
        }
      }
    }
  }

  return options.includeDisabled ? results : results.filter((s) => s.enabled)
}

/** 加载指定 skill 的完整内容（extraDirs/options 与 scanSkills 一致） */
export function loadSkill(name: string, extraDirs: string[] = [], options: ScanOptions = {}): SkillContent | null {
  const allSkills = scanSkills(extraDirs, { ...options, includeDisabled: true })
  const meta = allSkills.find((s) => s.name === name)
  if (!meta) return null

  const skillMdPath = join(meta.path, "SKILL.md")
  try {
    const raw = fs.readFileSync(skillMdPath, "utf-8")
    const { body } = parseFrontmatter(raw)

    // 扫描关联文件
    const linkedFiles: string[] = []
    const referenceDirs = ["references", "templates", "scripts", "assets"]
    for (const sub of referenceDirs) {
      const subPath = join(meta.path, sub)
      if (fs.existsSync(subPath)) {
        for (const f of fs.readdirSync(subPath)) {
          linkedFiles.push(join(sub, f))
        }
      }
    }

    return { meta, content: body, linkedFiles }
  } catch {
    return null
  }
}

/** 查看 skill 指定目录下的关联文件（extraDirs/options 与 scanSkills 一致） */
export function loadSkillFile(name: string, filePath: string, extraDirs: string[] = [], options: ScanOptions = {}): string | null {
  const allSkills = scanSkills(extraDirs, { ...options, includeDisabled: true })
  const meta = allSkills.find((s) => s.name === name)
  if (!meta) return null

  // 关联文件路径约束在 skill 目录内（防目录穿越）
  const fullPath = resolve(meta.path, filePath)
  if (!fullPath.startsWith(meta.path + sep) && fullPath !== meta.path) return null
  if (!fs.existsSync(fullPath)) return null

  try {
    return fs.readFileSync(fullPath, "utf-8")
  } catch {
    return null
  }
}
