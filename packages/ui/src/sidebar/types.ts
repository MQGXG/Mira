/** 模型类型（识图策略）：预置 4 类 + 允许用户自定义任意字符串；可为空 */
export type ModelType = "text" | "vision" | "multimodal" | "voice" | (string & {});

export interface ProviderModel {
  id: string;
  name: string;
  enabled: boolean;
  /** 模型类型：决定识图策略（vision/multimodal 直发图片，其余走视觉桥）；空则按内置白名单/兜底判断 */
  type?: ModelType;
}

export interface Provider {
  id: string;
  name: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  website?: string;
  apiFormat: "openai" | "anthropic" | "custom";
  headers: Record<string, string>;
  options: Record<string, string | number | boolean>;
  models: ProviderModel[];
}

export interface ProviderFormData {
  id: string;
  name: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  website: string;
  apiFormat: "openai" | "anthropic" | "custom";
  headers: Array<{ key: string; value: string }>;
  options: Array<{ key: string; value: string }>;
  models: Array<{ id: string; name: string; type?: ModelType }>;
}
