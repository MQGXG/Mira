/**
 * Skill 服务 — ctx.skill
 * 持有可扩展 skill 目录（addSkillDir 插件注册），scanSkills/loadSkill 经服务寻址。
 */

import { Service } from "../vendor/cordis/index"
import { getSkillsDir, scanSkills, loadSkill, loadSkillFile } from "../skill/skill-loader"
import type { SkillMeta, SkillContent } from "../skill/skill-loader"
import type { SkillService } from "../framework/context"

export class MiraSkillService extends Service implements SkillService {
  static provide = "skill"

  private extraDirs: string[] = []

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "skill")
  }

  list(): Array<{ name: string; description: string; category?: string }> {
    return scanSkills(this.extraDirs).map((m: SkillMeta) => ({
      name: m.name,
      description: m.description,
      category: m.category ?? undefined,
    }))
  }

  load(name: string): SkillContent | null {
    return loadSkill(name, this.extraDirs)
  }

  loadFile(name: string, filePath: string): string | null {
    return loadSkillFile(name, filePath, this.extraDirs)
  }

  getSkillDirs(): string[] {
    return [getSkillsDir(), ...this.extraDirs]
  }

  /** 注册额外 skill 目录（插件/项目级），返回 disposer 可逆 */
  addSkillDir(dir: string): () => void {
    this.extraDirs.push(dir)
    return () => {
      const idx = this.extraDirs.indexOf(dir)
      if (idx >= 0) this.extraDirs.splice(idx, 1)
    }
  }
}