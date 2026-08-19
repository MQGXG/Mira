import { useState, useRef, useEffect } from "react";
import { ChevronDown, Brain, Search, Zap, Shield, Cpu, Sparkles } from "lucide-react";
import type { AgentMode } from "./types";
import type { ModelType } from "../sidebar/types";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";

interface StoredModel { id: string; name: string; enabled: boolean; type?: ModelType; }
interface StoredProvider { id: string; name: string; displayName: string; enabled: boolean; models: StoredModel[]; }

function loadProviders(): StoredProvider[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem("providers_v2");
    if (data) return (JSON.parse(data) as StoredProvider[]).map((p) => ({ id: p.id, name: p.name, displayName: p.displayName || p.name, enabled: p.enabled, models: p.models?.map((m) => ({ id: m.id, name: m.name, enabled: m.enabled !== false, type: m.type })) || [] }));
    const oldData = localStorage.getItem("providers");
    if (oldData) return (JSON.parse(oldData) as StoredProvider[]).map((p) => ({ ...p, displayName: p.name, models: p.models?.map((m) => ({ id: m.id, name: m.name, enabled: true, type: undefined })) || [] }));
    return [];
  } catch { return []; }
}

function getEnabledModels(): ModelOption[] {
  const providers = loadProviders();
  const options: ModelOption[] = [];
  for (const p of providers) { if (!p.enabled) continue; for (const m of p.models) { if (!m.enabled) continue; options.push({ label: `${p.displayName || p.name} · ${m.name}`, value: m.id, provider: p.id.startsWith("custom-") ? "custom" : p.id, type: m.type }); } }
  return options;
}

export interface ModelOption { label: string; value: string; provider: string; type?: ModelType; }
const DEFAULT_MODEL: ModelOption = { label: "OpenAI · GPT-4o", value: "gpt-4o", provider: "openai" };

const MODE_OPTIONS: { value: AgentMode; label: string; icon: typeof Brain }[] = [
  { value: "assistant", label: "助手", icon: Sparkles },
  { value: "plan", label: "规划", icon: Search },
  { value: "expert", label: "专家", icon: Zap },
  { value: "action", label: "执行", icon: Cpu },
  { value: "safe", label: "安全", icon: Shield },
];

export function loadModelChoice(): ModelOption {
  if (typeof window === "undefined") return DEFAULT_MODEL;
  try { const saved = localStorage.getItem("chat_model"); if (saved) { const parsed: ModelOption = JSON.parse(saved); const available = getEnabledModels(); const stillAvailable = available.find(m => m.value === parsed.value); if (stillAvailable) return stillAvailable; } } catch { /* ignore */ }
  return getEnabledModels()[0] || DEFAULT_MODEL;
}
export function loadModeChoice(): AgentMode {
  if (typeof window === "undefined") return "assistant";
  try { return (localStorage.getItem("chat_mode") as AgentMode) || "assistant"; } catch { return "assistant"; }
}
export function saveModelChoice(model: ModelOption): void { localStorage.setItem("chat_model", JSON.stringify(model)); }

interface Props { selectedModel: ModelOption; onModelChange: (model: ModelOption) => void; agentMode: AgentMode; onModeChange: (mode: AgentMode) => void; }

export function ModelSelector({ selectedModel, onModelChange, agentMode, onModeChange }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const availableModels = getEnabledModels();

  useEffect(() => { const handleClick = (e: MouseEvent) => { if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false); }; document.addEventListener("mousedown", handleClick); return () => document.removeEventListener("mousedown", handleClick); }, []);

  return (
    <div className="flex items-center gap-3">
      <div className="relative" ref={modelRef}>
        <button onClick={() => setModelOpen(!modelOpen)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all"
          style={{ color: availableModels.length > 0 ? "var(--fg-secondary)" : "var(--fg-tertiary)", background: "var(--bg-secondary)" }}>
          <Brain className="w-3.5 h-3.5" />
          <span className="max-w-[140px] truncate">{availableModels.length > 0 ? selectedModel.label : "请配置模型"}</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${modelOpen ? "rotate-180" : ""}`} />
        </button>
        {modelOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl overflow-hidden shadow-lg z-50 animate-message"
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", boxShadow: "var(--shadow-floating)" }}>
            <div className="px-3 py-2 text-[10px] font-medium" style={{ color: "var(--fg-tertiary)" }}>选择模型</div>
            <div className="max-h-56 overflow-y-auto scrollbar-custom p-1">
              {availableModels.map((opt) => (
                <button key={opt.value} onClick={() => { onModelChange(opt); saveModelChoice(opt); setModelOpen(false); }}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-all ${selectedModel.value === opt.value ? "bg-primary/10" : "hover:bg-muted"}`}
                  style={{ color: selectedModel.value === opt.value ? "var(--primary)" : "var(--fg-secondary)" }}>
                  <div className="font-medium" style={{ color: selectedModel.value === opt.value ? "var(--primary)" : "var(--fg)" }}>{opt.label}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: "var(--fg-tertiary)" }}>{opt.provider === "openai" ? "OpenAI" : opt.provider === "claude" ? "Anthropic" : opt.provider === "ollama" ? "本地" : "自定义"}</div>
                </button>
              ))}
              {availableModels.length === 0 && <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--fg-tertiary)" }}>请在设置中启用模型</div>}
            </div>
          </div>
        )}
      </div>

      <Tabs value={agentMode} onValueChange={(v) => { onModeChange(v as AgentMode); localStorage.setItem("chat_mode", v); }}>
        <TabsList className="h-7 gap-0.5 px-1">
          {MODE_OPTIONS.map((m) => {
            const Icon = m.icon;
            return (
              <TabsTrigger key={m.value} value={m.value} title={m.label}
                className="h-6 gap-1 px-2 py-0 text-xs">
                <Icon className="h-3 w-3" />
                <span className="hidden sm:inline">{m.label}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </div>
  );
}
