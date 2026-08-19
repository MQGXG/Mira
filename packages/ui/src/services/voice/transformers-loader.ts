/**
 * transformers.js 加载层 — 薄代理到 core（@mira/core/voice）
 *
 * 保留 @mira/ui 公共 API 签名（向后兼容），实现委托给 core（含环境配置）。
 */

export {
  loadASRPipeline,
  loadTTSPipeline,
  type ASRPipeline,
  type TTSPipeline,
} from "@mira/core/voice"