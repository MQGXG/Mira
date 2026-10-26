/**
 * Skill 服务 — ctx.skill
 * 持有可扩展 skill 目录（addSkillDir 插件注册），scanSkills/loadSkill 经服务寻址。
 * 扩展：skills.json 持久化（用户添加目录 + 禁用名单）、来源标记、目录管理（设置页「扩展」用）
 */

import fs from "fs"
import { Service } from "../vendor/cordis/index"
import {
  getSkillsDir,
  getCompatGlobalSkillDirs,
  getSkillsConfigPath,
  isValidSkillName,
  readSkillsConfig,
  writeSkillsConfig,
  scanSkills,
  loadSkill,
  loadSkillFile,
  uninstallSkill,
} from "../skill/skill-loader"
import type { SkillMeta, SkillContent, SkillSource, ScanOptions } from "../skill/skill-loader"
import { importSkill } from "../skill/skill-importer"
import type { SkillImportInput, SkillImportResult } from "../skill/skill-importer"
import type { SkillService } from "../framework/context"

/** 设置页 skill 条目（含来源/启用状态/命名规范校验） */
export interface SkillEntry {
  name: string
  description: string
  category?: string
  path: string
  source: SkillSource
  enabled: boolean
  /** name 是否符合 OpenCode Agent Skills 规范（小写+单连字符） */
  validName: boolean
}

/** skill 目录条目（设置页目录管理） */
export interface SkillDirEntry {
  path: string
  source: "mira" | "user" | "plugin" | "compat"
  exists: boolean
  /** 用户目录可移除；内置/插件/兼容目录不可移除 */
  removable: boolean
}

export class MiraSkillService extends Service implements SkillService {
  static provide = "skill"

  /** 插件注册的额外目录（内存态，disposer 可逆）；持久化用户目录由 skills.json 管理 */
  private extraDirs: string[] = []

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "skill")
  }

  /** 仅启用的 skill（斜杠命令/工具/旧调用方兼容） */
  list(): Array<{ name: string; description: string; category?: string }> {
    return scanSkills(this.extraDirs).map((m: SkillMeta) => ({
      name: m.name,
      description: m.description,
      category: m.category ?? undefined,
    }))
  }

  /** 全量 skill（含禁用项，设置页用），带来源/路径/命名校验 */
  listAll(options: ScanOptions = {}): SkillEntry[] {
    return scanSkills(this.extraDirs, { ...options, includeDisabled: true }).map((m: SkillMeta) => ({
      name: m.name,
      description: m.description,
      category: m.category ?? undefined,
      path: m.path,
      source: m.source,
      enabled: m.enabled,
      validName: isValidSkillName(m.name),
    }))
  }

  /** 目录清单（内置/用户/插件/全局兼容，含存在性与可移除标记） */
  listDirs(): SkillDirEntry[] {
    const cfg = readSkillsConfig()
    const entry = (path: string, source: SkillDirEntry["source"], removable: boolean): SkillDirEntry => ({
      path,
      source,
      exists: fs.existsSync(path),
      removable,
    })
    return [
      entry(getSkillsDir(), "mira", false),
      ...cfg.extraDirs.map((d) => entry(d, "user", true)),
      ...this.extraDirs.map((d) => entry(d, "plugin", false)),
      ...getCompatGlobalSkillDirs().map(({ dir }) => entry(dir, "compat", false)),
    ]
  }

  /** 添加用户 skill 目录（持久化到 skills.json；目录必须存在） */
  addUserDir(dir: string): { success: boolean; error?: string } {
    if (!dir || !fs.existsSync(dir)) return { success: false, error: `目录不存在: ${dir}` }
    if (!fs.statSync(dir).isDirectory()) return { success: false, error: `不是目录: ${dir}` }
    const cfg = readSkillsConfig()
    if (cfg.extraDirs.includes(dir)) return { success: false, error: "目录已添加" }
    cfg.extraDirs.push(dir)
    writeSkillsConfig(cfg)
    return { success: true }
  }

  /** 移除用户 skill 目录（只移除注册，不删除磁盘文件） */
  removeUserDir(dir: string): { success: boolean; error?: string } {
    const cfg = readSkillsConfig()
    const idx = cfg.extraDirs.indexOf(dir)
    if (idx < 0) return { success: false, error: "该目录不在用户目录列表中" }
    cfg.extraDirs.splice(idx, 1)
    writeSkillsConfig(cfg)
    return { success: true }
  }

  /** 启用/禁用 skill（按名称写入 skills.json disabled 名单，斜杠命令/工具即时跟随） */
  setEnabled(name: string, enabled: boolean): { success: boolean; error?: string } {
    const cfg = readSkillsConfig()
    const idx = cfg.disabled.indexOf(name)
    if (enabled && idx >= 0) {
      cfg.disabled.splice(idx, 1)
    } else if (!enabled && idx < 0) {
      cfg.disabled.push(name)
    }
    writeSkillsConfig(cfg)
    return { success: true }
  }

  /** 卸载 skill（删除其目录；带安全约束，见 uninstallSkill） */
  uninstall(name: string, options: ScanOptions = {}): { success: boolean; error?: string; path?: string } {
    return uninstallSkill(name, this.extraDirs, options)
  }

  /** 导入 skill（zip 压缩包或单个 .md，自动解压安装到 skills 目录；高风险或 autoInstall=false 需 confirmed=true；skipRiskCheck=true 跳过风险确认直接安装） */
  importSkill(
    input: SkillImportInput,
    options: { confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean } = {},
  ): Promise<SkillImportResult> {
    return importSkill(input, options)
  }

  /** skills.json 配置路径（设置页展示入口） */
  getConfigPath(): string {
    return getSkillsConfigPath()
  }

  load(name: string, options: ScanOptions = {}): SkillContent | null {
    return loadSkill(name, this.extraDirs, options)
  }

  loadFile(name: string, filePath: string, options: ScanOptions = {}): string | null {
    return loadSkillFile(name, filePath, this.extraDirs, options)
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
