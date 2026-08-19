import { Cpu } from "lucide-react";

export function AboutSettings() {
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-primary">关于 Mira</h3>
      <div className="p-6 rounded-xl space-y-4 bg-surface-secondary border border-standard">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--primary) 10%, transparent)' }}>
            <Cpu className="w-6 h-6" style={{ color: "var(--primary)" }} />
          </div>
          <div>
            <div className="text-lg font-medium text-primary">Mira</div>
            <div className="text-xs text-secondary">版本 1.0.0</div>
          </div>
        </div>
        <div className="text-sm leading-relaxed text-secondary">全能 AI 助手桌面应用，支持多模型切换、工具调用、文件分析。</div>
        <div className="text-xs space-y-1 text-tertiary">
          <div>Electron 31 · React 18 · TypeScript 5</div>
          <div>OpenAI SDK · Anthropic SDK · SQLite</div>
        </div>
      </div>
    </div>
  );
}
