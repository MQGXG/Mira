/**
 * Skill 工具 — skills_list 和 skill_view
 * 注册到默认工具注册表，让 Agent 可以调用
 */

import { z } from "zod"
import { make } from "../shared/tool"
import { scanSkills, loadSkill, loadSkillFile } from "./skill-loader"

/** skills_list 工具：列出所有可用 Skill */
export const skillsListTool = make({
  name: "skills_list",
  description: "列出所有可用的 Skill，返回名称、描述和分类",
  inputSchema: z.object({
    category: z.string().optional().describe("按分类筛选"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    const all = scanSkills()
    const filtered = input.category
      ? all.filter((s) => s.category === input.category)
      : all

    if (filtered.length === 0) {
      return {
        success: true,
        output: "没有找到已安装的 Skill。请先在 ~/.config/mira/skills/ 目录下创建。",
      }
    }

    const lines = filtered.map((s) => {
      const cat = s.category ? `[${s.category}]` : "[未分类]"
      return `- ${s.name} ${cat} — ${s.description}`
    })

    return {
      success: true,
      output: `可用 Skill (${filtered.length} 个):\n\n${lines.join("\n")}\n\n使用 skill_view(name) 查看完整内容。`,
    }
  },
})

/** skill_view 工具：查看指定 Skill 的完整内容 */
export const skillViewTool = make({
  name: "skill_view",
  description: "查看指定 Skill 的完整指令内容和关联文件列表",
  inputSchema: z.object({
    name: z.string().describe("Skill 名称"),
    file_path: z.string().optional().describe("关联文件路径（可选）"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    if (input.file_path) {
      const content = loadSkillFile(input.name, input.file_path)
      if (!content) {
        return { success: false, error: `文件 ${input.file_path} 在 Skill ${input.name} 中不存在` }
      }
      return { success: true, output: `[${input.name}/${input.file_path}]\n\n${content}` }
    }

    const skill = loadSkill(input.name)
    if (!skill) {
      return { success: false, error: `Skill '${input.name}' 未找到。用 skills_list 查看所有可用的 Skill。` }
    }

    const parts: string[] = []
    parts.push(`# Skill: ${skill.meta.name}`)
    if (skill.meta.description) parts.push(`\n描述: ${skill.meta.description}`)
    if (skill.meta.category) parts.push(`分类: ${skill.meta.category}`)

    parts.push(`\n${skill.content}`)

    if (skill.linkedFiles.length > 0) {
      parts.push(`\n---\n关联文件:`)
      for (const f of skill.linkedFiles) {
        parts.push(`- ${f}  (用 skill_view(name="${skill.meta.name}", file_path="${f}") 查看)`)
      }
    }

    return { success: true, output: parts.join("\n") }
  },
})
