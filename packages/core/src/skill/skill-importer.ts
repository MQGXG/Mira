/**
 * Skill 导入器 — 从 .zip 压缩包 / 单个 .md / 本地文件夹导入 Skill
 * 流程：解析 → 校验（SKILL.md + YAML frontmatter name/description）→ 风险扫描 → 安装到 ~/.config/mira/skills/<name>/
 * 风险分级：
 *   - 高风险（默认需用户确认才能安装）：zip 内含可执行文件（.exe/.bat/.ps1/.sh…）、zip-slip 路径穿越条目
 *   - 低风险（勾选「非高风险自动安装」后直接安装）：仅文档类文件
 */

import fs from "fs"
import { join, normalize, resolve, sep } from "path"
import { getSkillsDir, isValidSkillName } from "./skill-loader"

/** 导入输入（zip / md / 本地文件夹三选一） */
export interface SkillImportInput {
  fileName: string
  /** zip 压缩包内容（base64） */
  zipBase64?: string
  /** 单个 SKILL.md 内容（文本） */
  mdContent?: string
  /** 本地文件夹路径（与 sidecar 同机，直接校验后复制安装） */
  folderPath?: string
}

/** 风险条目 */
export interface SkillImportRisk {
  level: "info" | "warning"
  message: string
}

/** 导入结果 */
export interface SkillImportResult {
  success: boolean
  /** true = 检测到高风险/需要确认，UI 展示风险清单后带 confirmed=true 重试 */
  needsConfirm?: boolean
  riskLevel: "low" | "high"
  risks: SkillImportRisk[]
  /** 解析出的 skill 名称（确认前也能看到） */
  name?: string
  /** 安装目标目录（仅安装成功后） */
  path?: string
  error?: string
}

/** 高风险：可执行/脚本类文件后缀（skill 通常只需文档，出现这些需要用户确认） */
const HIGH_RISK_EXT = /\.(exe|bat|cmd|com|scr|msi|jar|dll|ps1|psm1|sh|bash|zsh|vbs|vb|app|dmg|pkg)$/i

/** zip 单条目大小上限（10MB，防解压炸弹） */
const MAX_ENTRY_SIZE = 10 * 1024 * 1024

/** zip 整体解压后大小上限（50MB） */
const MAX_TOTAL_SIZE = 50 * 1024 * 1024

/** zip 条目数量上限 */
const MAX_ENTRIES = 500

/** 高风险模式：SKILL.md 正文出现危险指令（提示级，不阻断） */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /rm\s+-rf|Remove-Item\s+.*-Recurse/i, message: "SKILL.md 中包含递归删除指令" },
  { re: /\bsudo\b|\belevated\b/i, message: "SKILL.md 中包含提权指令" },
  { re: /\bcurl\s+[^\n]*\|\s*(sh|bash|powershell)|iwr\s+[^\n]*\|\s*iex/i, message: "SKILL.md 中包含下载并执行远程脚本的指令" },
]

/** 解析 SKILL.md 的 YAML frontmatter（与 skill-loader 保持一致的简易解析） */
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
      if (value.startsWith("[")) {
        frontmatter[key] = value.slice(1, -1).split(",").map((s) => s.trim().replace(/['"]/g, ""))
      } else {
        frontmatter[key] = value.replace(/^['"]|['"]$/g, "")
      }
    }
  }
  return { frontmatter, body: lines.slice(endIdx + 1).join("\n").trim() }
}

/** zip 条目路径安全校验（防 zip-slip：拒绝 ..、绝对路径、盘符） */
function isSafeEntryPath(entryPath: string): boolean {
  if (!entryPath) return false
  const normalized = normalize(entryPath)
  if (normalized.includes("..")) return false
  if (/^[a-zA-Z]:/.test(entryPath)) return false
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false
  return true
}

/** 校验 skill 内容（SKILL.md 必须含 name + description），返回风险清单 */
function validateSkill(
  skillMd: string,
  dirName: string,
  fileNames: string[],
): { name: string; risks: SkillImportRisk[]; error?: string } {
  const { frontmatter, body } = parseFrontmatter(skillMd)
  const name = String(frontmatter.name || dirName).slice(0, 64)
  const description = String(frontmatter.description || "").trim()

  if (!name) return { name: dirName, risks: [], error: "SKILL.md 缺少技能名称（frontmatter name 或目录名）" }
  if (!description) return { name, risks: [], error: "SKILL.md 缺少技能描述（YAML frontmatter description）" }

  const risks: SkillImportRisk[] = []
  if (!isValidSkillName(name)) {
    risks.push({ level: "info", message: `名称 "${name}" 不符合 OpenCode 规范（小写字母数字 + 单连字符），其他工具可能无法发现它` })
  }
  for (const f of fileNames) {
    if (HIGH_RISK_EXT.test(f)) {
      risks.push({ level: "warning", message: `包含可执行/脚本文件：${f}` })
    }
  }
  for (const { re, message } of DANGEROUS_PATTERNS) {
    if (re.test(body)) risks.push({ level: "warning", message })
  }

  return { name, risks }
}

/** 导入 skill（两阶段：分析 → 需确认时安装）
 * autoInstall=false 时低风险也返回 needsConfirm（用户关闭「非高风险自动安装」= 所有导入都先看风险清单）
 * skipRiskCheck=true 时跳过风险确认直接安装（用户主动「跳过检测」）——结构性防护（zip-slip/炸弹/缺 SKILL.md）不可跳过
 */
export async function importSkill(
  input: SkillImportInput,
  options: { confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean } = {},
): Promise<SkillImportResult> {
  if (input.zipBase64) return importFromZip(input.zipBase64, options)
  if (input.mdContent) return importFromMd(input.mdContent, options)
  if (input.folderPath) return importFromFolder(input.folderPath, options)
  return { success: false, riskLevel: "low", risks: [], error: "缺少文件内容（zipBase64 / mdContent / folderPath）" }
}

/**
 * 本地文件夹导入：定位 SKILL.md（文件夹根或唯一子目录）→ 校验 → 风险扫描 → 复制到 skills/<name>/
 * 与 sidecar 同机，直接 fs 操作；源已在 skills 目录内时无需复制
 */
async function importFromFolder(
  folderPath: string,
  options: { confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean } = {},
): Promise<SkillImportResult> {
  const srcRoot = resolve(folderPath)
  let srcStat: fs.Stats
  try {
    srcStat = fs.statSync(srcRoot)
  } catch {
    return { success: false, riskLevel: "low", risks: [], error: `文件夹不存在：${srcRoot}` }
  }
  if (!srcStat.isDirectory()) return { success: false, riskLevel: "low", risks: [], error: `不是文件夹：${srcRoot}` }

  // 定位 SKILL.md：文件夹根目录，或唯一含 SKILL.md 的一级子目录（zip 同款约定）
  let skillRoot = srcRoot
  if (!fs.existsSync(join(srcRoot, "SKILL.md"))) {
    const subDirs = safeListDirs(srcRoot).filter((d) => fs.existsSync(join(srcRoot, d, "SKILL.md")))
    if (subDirs.length === 0) return { success: false, riskLevel: "low", risks: [], error: "文件夹中未找到 SKILL.md" }
    if (subDirs.length > 1) return { success: false, riskLevel: "low", risks: [], error: "文件夹包含多个含 SKILL.md 的子目录（一次只导入一个 skill）" }
    skillRoot = join(srcRoot, subDirs[0])
  }

  // 枚举文件（限制数量/大小，防恶意超大目录）
  const files: Array<{ rel: string; abs: string; size: number }> = []
  let totalSize = 0
  const walkError = walkFiles(skillRoot, "", files, { count: 0, totalSize: 0 })
  if (walkError) return { success: false, riskLevel: "high", risks: [], error: walkError }
  for (const f of files) totalSize += f.size
  if (totalSize > MAX_TOTAL_SIZE) return { success: false, riskLevel: "high", risks: [], error: `文件夹总大小超限（>${MAX_TOTAL_SIZE / 1024 / 1024}MB）` }

  const skillMdAbs = join(skillRoot, "SKILL.md")
  const skillMd = fs.readFileSync(skillMdAbs, "utf-8")
  const relPaths = files.map((f) => f.rel)
  const dirName = skillRoot === srcRoot ? "" : skillRoot.slice(srcRoot.length + 1)
  const validated = validateSkill(skillMd, dirName, relPaths)
  if (validated.error) return { success: false, riskLevel: "low", risks: [], error: validated.error }

  const highRisk = validated.risks.some((r) => r.level === "warning")
  // 高风险必确认；关闭「非高风险自动安装」时低风险也确认；skipRiskCheck 直接放行
  const needConfirm = !options.skipRiskCheck && (highRisk || options.autoInstall === false)
  if (needConfirm && !options.confirmed) {
    return { success: false, needsConfirm: true, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name }
  }

  const targetDir = join(getSkillsDir(), validated.name)
  // 源已在目标位置（用户直接选了 skills 下的目录）：无需复制
  if (normalize(skillRoot) === normalize(targetDir)) {
    return { success: true, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, path: targetDir }
  }
  if (fs.existsSync(targetDir)) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, error: `已存在同名 skill：${targetDir}（请先卸载）` }
  }

  // 复制安装（保持内部相对路径）
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    for (const f of files) {
      const dest = join(targetDir, f.rel)
      if (!normalize(dest).startsWith(normalize(targetDir) + sep)) continue // 双保险
      fs.mkdirSync(join(dest, ".."), { recursive: true })
      fs.copyFileSync(f.abs, dest)
    }
  } catch (e) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, error: e instanceof Error ? e.message : String(e) }
  }

  return { success: true, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, path: targetDir }
}

/** 安全列举一级子目录名（隐藏项跳过，容错） */
function safeListDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * 递归枚举文件夹内文件（返回错误字符串表示失败）
 * 限制：条目数 ≤ MAX_ENTRIES、单文件 ≤ MAX_ENTRY_SIZE、跳过符号链接与隐藏项
 */
function walkFiles(
  root: string,
  rel: string,
  out: Array<{ rel: string; abs: string; size: number }>,
  counters: { count: number; totalSize: number },
): string | null {
  const abs = rel ? join(root, rel) : root
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return null // 不可读目录跳过
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue // 隐藏项（.git 等）不导入
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const childAbs = join(root, childRel)
    if (e.isSymbolicLink()) continue // 符号链接跳过（防指向目录外）
    counters.count++
    if (counters.count > MAX_ENTRIES) return `文件夹条目过多（>${MAX_ENTRIES}）`
    if (e.isDirectory()) {
      const err = walkFiles(root, childRel, out, counters)
      if (err) return err
    } else if (e.isFile()) {
      let size = 0
      try {
        size = fs.statSync(childAbs).size
      } catch {
        continue
      }
      if (size > MAX_ENTRY_SIZE) return `文件过大（>${MAX_ENTRY_SIZE / 1024 / 1024}MB）：${childRel}`
      counters.totalSize += size
      out.push({ rel: childRel, abs: childAbs, size })
    }
  }
  return null
}

/** 单个 .md 文件导入：写入 ~/.config/mira/skills/<name>/SKILL.md */
async function importFromMd(
  mdContent: string,
  options: { confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean } = {},
): Promise<SkillImportResult> {
  const risks: SkillImportRisk[] = []
  for (const { re, message } of DANGEROUS_PATTERNS) {
    if (re.test(mdContent)) risks.push({ level: "warning", message })
  }
  const highRisk = risks.some((r) => r.level === "warning")

  const { frontmatter } = parseFrontmatter(mdContent)
  const name = String(frontmatter.name || "").slice(0, 64)
  if (!name) return { success: false, riskLevel: highRisk ? "high" : "low", risks, error: "缺少技能名称（YAML frontmatter name）" }

  const validated = validateSkill(mdContent, name, [])
  if (validated.error) return { success: false, riskLevel: highRisk ? "high" : "low", risks, name, error: validated.error }

  // 高风险必确认；关闭「非高风险自动安装」时低风险也确认；skipRiskCheck 直接放行
  const needConfirm = !options.skipRiskCheck && (highRisk || options.autoInstall === false)
  if (needConfirm && !options.confirmed) {
    return { success: false, needsConfirm: true, riskLevel: highRisk ? "high" : "low", risks, name }
  }

  const targetDir = join(getSkillsDir(), name)
  if (fs.existsSync(targetDir)) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks, name, error: `已存在同名 skill：${targetDir}（请先卸载）` }
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(join(targetDir, "SKILL.md"), mdContent, "utf-8")
  } catch (e) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks, name, error: e instanceof Error ? e.message : String(e) }
  }
  return { success: true, riskLevel: highRisk ? "high" : "low", risks, name, path: targetDir }
}

/** zip 压缩包导入：定位 SKILL.md → 校验 → 风险扫描 → 解压到 skills/<name>/ */
async function importFromZip(
  zipBase64: string,
  options: { confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean } = {},
): Promise<SkillImportResult> {
  const JSZip = (await import("jszip")).default
  let zip: InstanceType<typeof JSZip>
  try {
    zip = await JSZip.loadAsync(Buffer.from(zipBase64, "base64"))
  } catch (e) {
    return { success: false, riskLevel: "low", risks: [], error: `无法解析 zip：${e instanceof Error ? e.message : String(e)}` }
  }

  const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir)
  if (entries.length === 0) return { success: false, riskLevel: "low", risks: [], error: "压缩包为空" }
  if (entries.length > MAX_ENTRIES) return { success: false, riskLevel: "high", risks: [], error: `条目过多（${entries.length} > ${MAX_ENTRIES}），拒绝导入` }

  // zip-slip 校验：任何不安全路径直接拒绝
  const unsafe = entries.filter((p) => !isSafeEntryPath(p))
  if (unsafe.length > 0) {
    return {
      success: false,
      riskLevel: "high",
      risks: [{ level: "warning", message: `压缩包包含不安全路径（zip-slip），已拒绝：${unsafe[0]}` }],
      error: "压缩包包含不安全路径，拒绝导入",
    }
  }

  // 定位 SKILL.md（大小写敏感，对齐 OpenCode 规范）
  const skillMdEntries = entries.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
  if (skillMdEntries.length === 0) return { success: false, riskLevel: "low", risks: [], error: "压缩包中未找到 SKILL.md" }
  if (skillMdEntries.length > 1) return { success: false, riskLevel: "low", risks: [], error: "压缩包包含多个 SKILL.md（一个压缩包只装一个 skill）" }

  // 计算 SKILL.md 所在子目录前缀（zip 常见单层根文件夹）
  const skillMdPath = skillMdEntries[0]
  const prefix = skillMdPath === "SKILL.md" ? "" : skillMdPath.slice(0, skillMdPath.length - "SKILL.md".length)

  // 前缀内条目 = 该 skill 的文件集
  const skillFiles = prefix ? entries.filter((p) => p.startsWith(prefix)) : entries
  const relPaths = skillFiles.map((p) => p.slice(prefix.length))

  // 大小/数量限制（防解压炸弹）——uncompressedSize 取自 zip 中央目录（解压前可读）
  let totalSize = 0
  for (const p of skillFiles) {
    const size = (zip.files[p] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (size > MAX_ENTRY_SIZE) return { success: false, riskLevel: "high", risks: [], error: `文件过大（>${MAX_ENTRY_SIZE / 1024 / 1024}MB）：${p}` }
    totalSize += size
  }
  if (totalSize > MAX_TOTAL_SIZE) return { success: false, riskLevel: "high", risks: [], error: `解压总大小超限（>${MAX_TOTAL_SIZE / 1024 / 1024}MB）` }

  const skillMd = await zip.files[skillMdPath].async("string")
  // 目录名兜底：前缀形如 "<category>/<name>/" 取最后一段；否则用 skill 名
  const prefixSegments = prefix.split("/").filter(Boolean)
  const dirName = prefixSegments.length > 0 ? prefixSegments[prefixSegments.length - 1] : ""
  const validated = validateSkill(skillMd, dirName, relPaths)
  if (validated.error) return { success: false, riskLevel: "low", risks: [], error: validated.error }

  const highRisk = validated.risks.some((r) => r.level === "warning")
  // 高风险必确认；关闭「非高风险自动安装」时低风险也确认；skipRiskCheck 直接放行
  const needConfirm = !options.skipRiskCheck && (highRisk || options.autoInstall === false)
  if (needConfirm && !options.confirmed) {
    return { success: false, needsConfirm: true, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name }
  }

  const targetDir = join(getSkillsDir(), validated.name)
  if (fs.existsSync(targetDir)) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, error: `已存在同名 skill：${targetDir}（请先卸载）` }
  }

  // 解压写入（保持 skill 内部相对路径）
  try {
    for (const p of skillFiles) {
      const rel = p.slice(prefix.length)
      if (!rel) continue
      const dest = join(targetDir, rel)
      if (!normalize(dest).startsWith(normalize(targetDir))) continue // 双保险防 zip-slip
      fs.mkdirSync(join(dest, ".."), { recursive: true })
      const data = await zip.files[p].async("nodebuffer")
      fs.writeFileSync(dest, data)
    }
  } catch (e) {
    return { success: false, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, error: e instanceof Error ? e.message : String(e) }
  }

  return { success: true, riskLevel: highRisk ? "high" : "low", risks: validated.risks, name: validated.name, path: targetDir }
}
