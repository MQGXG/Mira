import { useState } from "react";
import { Search, Cpu } from "lucide-react";
import type { Provider, ProviderModel } from "./types";
import { Switch } from "../components/ui/switch";
import { Input } from "../components/ui/input";

interface Props {
  providers: Provider[];
  onChange: (list: Provider[]) => void;
}

export function ModelManager({ providers, onChange }: Props) {
  const [search, setSearch] = useState("");

  const toggleModel = (providerId: string, modelId: string) => {
    onChange(
      providers.map((p) => {
        if (p.id !== providerId) return p;
        return { ...p, models: p.models.map((m) => m.id === modelId ? { ...m, enabled: !m.enabled } : m) };
      })
    );
  };

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, providerId: p.id, providerName: p.displayName || p.name }))
  );

  const filtered = search
    ? allModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.providerName.toLowerCase().includes(search.toLowerCase()))
    : allModels;

  const grouped = filtered.reduce((acc, model) => {
    if (!acc[model.providerName]) acc[model.providerName] = [];
    acc[model.providerName].push(model);
    return acc;
  }, {} as Record<string, typeof filtered>);

  const enabledCount = allModels.filter((m) => m.enabled).length;
  const totalCount = allModels.length;

  return (
    <div className="max-w-3xl xl:max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-primary">模型</h3>
          <p className="text-xs mt-1 text-secondary">管理所有可用模型，启用后可在对话框中选择使用</p>
        </div>
        <div className="text-xs text-secondary">已启用 {enabledCount} / {totalCount}</div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-secondary" />
        <Input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索模型..."
          className="pl-10 pr-4 py-2.5 text-sm"
        />
      </div>

      <div className="space-y-6">
        {Object.entries(grouped).map(([providerName, models]) => (
          <div key={providerName} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <Cpu className="w-4 h-4 text-secondary" />
              <span className="text-sm font-medium text-primary">{providerName}</span>
              <span className="text-xs text-tertiary">({models.length})</span>
            </div>
            <div className="space-y-1">
              {models.map((model) => (
                <div key={`${model.providerId}-${model.id}`}
                  className="flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 bg-surface-elevated border border-standard">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full" style={{ background: model.enabled ? 'var(--success)' : 'var(--border)' }} />
                    <div>
                      <div className="text-sm text-primary">{model.name}</div>
                      <div className="text-xs font-mono text-tertiary">{model.id}</div>
                    </div>
                  </div>
                  <Switch checked={model.enabled}
                    onCheckedChange={() => toggleModel(model.providerId, model.id)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
