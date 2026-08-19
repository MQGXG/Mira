/**
 * 桌宠默认动作插件 — 基于 Live2D 标准参数名（HiYori 等模型通用）
 *
 * 参数名映射沿用 Live2D Cubism 4 默认：
 *   ParamAngleX/Y/Z     头部旋转
 *   ParamEyeLOpen/R    左右眼开合（1=睁）
 *   ParamBodyAngleX/Y   身体转动/倾斜
 *   ParamMouthOpenY     嘴开合
 *
 * 若目标模型缺参数，PetMotionManager 的 sink 会忽略（setParameterByName 内部 indexOf 检查）。
 */

import type { ActionPlugin, MotionAction, MotionContext } from "./motion-manager"

/** 预置情绪 → 目标参数（值 0..1 建议量） */
export const MOTION_PRESETS: Record<string, Record<string, number>> = {
  wave:     { ParamAngleZ: -0.25, ParamBodyAngleX: -0.1 },
  nod:      { ParamAngleX: -0.12, ParamBodyAngleY: -0.08 },
  shake:    { ParamAngleX: 0.15,  ParamBodyAngleY: -0.1 },
  joy:      { ParamEyeLOpen: 0.0, ParamEyeROpen: 0.0, ParamMouthOpenY: 0.35 },
  sad:      { ParamAngleX: 0.08,  ParamEyeLOpen: 0.25, ParamEyeROpen: 0.25, ParamMouthOpenY: 0.05 },
  surprise: { ParamEyeLOpen: 1.0, ParamEyeROpen: 1.0, ParamMouthOpenY: 0.5 },
  angry:    { ParamEyeLOpen: 0.3, ParamEyeROpen: 0.3, ParamMouthOpenY: 0.12 },
  think:    { ParamAngleZ: -0.15, ParamEyeLOpen: 0.6, ParamEyeROpen: 0.6 },
}

/**
 * 情绪动作插件：trigger 时把预设参数淡入到峰值，随 durationMs 钟形回归 0。
 * 参数值按 action.intensity 缩放。
 */
export function motionPresetPlugin(): ActionPlugin {
  const targets: Record<string, number> = {}
  let active = false
  let elapsed = 0
  let durSec = 0.8

  return {
    name: "motion:preset",
    idle: false,
    trigger(action: MotionAction) {
      const preset = MOTION_PRESETS[action.kind]
      if (!preset) return
      const intensity = action.intensity ?? 1
      durSec = (action.durationMs ?? 800) / 1000
      for (const [k, v] of Object.entries(preset)) targets[k] = v * intensity
      elapsed = 0
      active = true
    },
    update(ctx: MotionContext) {
      if (!active) return
      elapsed += ctx.delta
      const progress = Math.min(1, elapsed / durSec)
      const value = Math.sin(progress * Math.PI) // 钟形：中间 1，两端 0
      for (const [k, target] of Object.entries(targets)) {
        ctx.setParameter(k, target * value)
      }
      if (progress >= 1) active = false
    },
  }
}

/** 空闲眨眼插件：3~7 秒间隔，时间性闭合/张开 */
export function idleBlinkPlugin(): ActionPlugin {
  let phase: "open" | "closing" | "opening" = "open"
  let timerMs = 3000 + Math.random() * 4000
  let progress = 0

  return {
    name: "idle:blink",
    idle: true,
    update(ctx: MotionContext) {
      const dtMs = ctx.delta * 1000
      if (phase === "open") {
        timerMs -= dtMs
        if (timerMs <= 0) { phase = "closing"; progress = 0 }
        return
      }
      progress += dtMs / 120
      // 钳制到 0..1，防止巨大 delta 产生越界值
      const clamped = Math.min(1, Math.max(0, progress))
      if (phase === "closing") {
        ctx.setParameter("ParamEyeLOpen", 1 - clamped)
        ctx.setParameter("ParamEyeROpen", 1 - clamped)
        if (progress >= 1) { phase = "opening"; progress = 0 }
      } else {
        ctx.setParameter("ParamEyeLOpen", clamped)
        ctx.setParameter("ParamEyeROpen", clamped)
        if (progress >= 1) { phase = "open"; timerMs = 3000 + Math.random() * 4000 }
      }
    },
  }
}

/** 呼吸插件：缓慢起伏嘴部（避免完全死板） */
export function idleBreathPlugin(): ActionPlugin {
  let t = 0
  return {
    name: "idle:breath",
    idle: true,
    update(ctx: MotionContext) {
      t += ctx.delta
      const breath = 0.02 + 0.02 * Math.sin(t * 2.2) // 0..0.04 微幅
      ctx.setParameter("ParamMouthOpenY", breath)
    },
  }
}

/**
 * 合成默认插件栈（预设动作 + 眨眼 + 呼吸）。返回后通常 register 到 manager。
 */
export function defaultPetPlugins(): ActionPlugin[] {
  return [motionPresetPlugin(), idleBlinkPlugin(), idleBreathPlugin()]
}