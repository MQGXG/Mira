/**
 * Skill 加载器 — 扫描和加载 Skill 目录
 * 参考 Hermes Agent skill 系统：~/.config/mira/skills/<category>/<skill>/SKILL.md
 */

import { join } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"

export interface SkillMeta {
  name: string
  description: string
  category: string | null
  path: string
  tags: string[]
}

export interface SkillContent {
  meta: SkillMeta
  content: string
  linkedFiles: string[]
}

/** 获取 skills 根目录 */
export function getSkillsDir(): string {
  return join(getPlatformPaths().home, ".config", "mira", "skills")
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

/** 扫描 skills 目录（默认 ~/.config/mira/skills + 可选扩展目录，返回所有 skill 的元数据） */
export function scanSkills(extraDirs: string[] = []): SkillMeta[] {
  const dirs = [getSkillsDir(), ...extraDirs]
  const results: SkillMeta[] = []

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue

    try {
      for (const category of fs.readdirSync(dir)) {
        const categoryPath = join(dir, category)
        if (!fs.statSync(categoryPath).isDirectory()) continue

        for (const skillName of fs.readdirSync(categoryPath)) {
          const skillPath = join(categoryPath, skillName)
          if (!fs.statSync(skillPath).isDirectory()) continue

          const skillMdPath = join(skillPath, "SKILL.md")
          if (!fs.existsSync(skillMdPath)) continue

          try {
            const content = fs.readFileSync(skillMdPath, "utf-8")
            const { frontmatter, body } = parseFrontmatter(content)

            const name = frontmatter.name || skillName
            const description = frontmatter.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || ""

            results.push({
              name: String(name).slice(0, 64),
              description: String(description).slice(0, 1024),
              category: category === "_root" ? null : category,
              path: skillPath,
              tags: (frontmatter.tags || frontmatter["metadata.hermes.tags"] || []) as string[],
            })
          } catch {
            // 跳过无法读取的 skill
          }
        }
      }
    } catch {
      // 目录不存在或无法读取
    }
  }

  return results
}

/** 加载指定 skill 的完整内容（extraDirs 与 scanSkills 一致） */
export function loadSkill(name: string, extraDirs: string[] = []): SkillContent | null {
  const allSkills = scanSkills(extraDirs)
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

/** 查看 skill 指定目录下的关联文件（extraDirs 与 scanSkills 一致） */
export function loadSkillFile(name: string, filePath: string, extraDirs: string[] = []): string | null {
  const allSkills = scanSkills(extraDirs)
  const meta = allSkills.find((s) => s.name === name)
  if (!meta) return null

  const fullPath = join(meta.path, filePath)
  if (!fs.existsSync(fullPath)) return null

  try {
    return fs.readFileSync(fullPath, "utf-8")
  } catch {
    return null
  }
}

