/**
 * Skill slash 命令处理 — 解析用户输入中的 /skill-name 并构建 invocation 消息
 * 参考 Hermes Agent skill_commands.py
 */

import { scanSkills } from "./skill-loader"

/** 扫描所有已安装的 skill，返回 /command → meta 映射 */
export function getSkillCommands(): Record<string, { name: string; description: string; category: string | null }> {
  const commands: Record<string, { name: string; description: string; category: string | null }> = {}

  for (const skill of scanSkills()) {
    // 生成 slug：小写、空格替换为连字符
    const slug = skill.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    if (slug) {
      commands[`/${slug}`] = {
        name: skill.name,
        description: skill.description,
        category: skill.category,
      }
    }
  }

  return commands
}

/** 检查用户输入是否包含 skill 命令，返回匹配的命令 key 和剩余文本 */
export function matchSkillCommand(input: string): { command: string; name: string; rest: string } | null {
  const trimmed = input.trim()
  const commands = getSkillCommands()

  // 先按完整命令长度降序匹配（优先匹配较长的命令）
  const sorted = Object.entries(commands).sort(([a], [b]) => b.length - a.length)

  for (const [cmdKey, info] of sorted) {
    if (trimmed.startsWith(cmdKey)) {
      const rest = trimmed.slice(cmdKey.length).trim()
      return { command: cmdKey, name: info.name, rest }
    }
  }

  return null
}

/** 构建 skill invocation message，注入到用户消息 */
export function buildSkillInvocationMessage(
  skillName: string,
  userInstruction: string,
): string {
  return (
    `[IMPORTANT: The user has invoked the "${skillName}" skill, indicating they want ` +
    `you to follow its instructions. The full skill content is loaded below.]\n\n` +
    `[Skill: ${skillName}]\n\n` +
    (userInstruction ? `User instruction: ${userInstruction}\n\n` : "") +
    `Use skill_view(name="${skillName}") to read the full skill instructions before proceeding.`
  )
}
