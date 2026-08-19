import { useState, useEffect } from "react";
import { X, Sliders, Keyboard, Server, Layers, Info, Search } from "lucide-react";
import type { Provider } from "../types";
import { ProviderConfigPanel } from "../ProviderConfigPanel";
import { ModelManager } from "../ModelManager";
import { ConfigSourceIndicator } from "../ConfigSourceIndicator";
import { defaultProviders, loadProviders, saveProviders, loadSettings, saveSettings } from "../provider-data";
import { SETTINGS_TABS, useSettingsSearch } from "./useSettingsSearch";
import { GeneralSettings } from "./GeneralSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { AboutSettings } from "./AboutSettings";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Dialog, DialogPortal, DialogOverlay } from "../../components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

const tabIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  general: Sliders,
  shortcuts: Keyboard,
  providers: Server,
  models: Layers,
  about: Info,
};

export function SettingsDialog({ open, onClose }: Props) {
  const [tab, setTab] = useState<string>("general");
  const [providers, setProviders] = useState<Provider[]>(defaultProviders);
  const [settings, setSettings] = useState<Record<string, any>>(loadSettings);
  const [searchQuery, setSearchQuery] = useState("");

  const { filtered: matchedTabs, hasResult } = useSettingsSearch(searchQuery);

  const updateSettings = (patch: Record<string, any>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  useEffect(() => {
    if (open) {
      loadProviders().then(setProviders);
    }
  }, [open]);

  const handleProvidersChange = async (list: Provider[]) => {
    setProviders(list);
    await saveProviders(list);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-black/30 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 w-full h-full bg-surface flex"
          style={{ animation: 'slideIn 250ms cubic-bezier(0.16, 1, 0.3, 1)' }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={onClose}
        >
          <div className="w-56 md:w-64 2xl:w-72 flex flex-col shrink-0 bg-surface-secondary border-r border-standard">
            <div className="px-4 py-5 space-y-3 border-b border-standard">
              <h2 className="text-sm font-medium text-primary">设置</h2>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-secondary" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索设置..."
                  className="pl-8 pr-2 py-1.5 text-xs"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                    <X className="w-3 h-3 text-secondary hover:text-foreground transition-colors" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-2 space-y-1 scrollbar-custom">
              {matchedTabs.map((t) => {
                const Icon = tabIcons[t.id];
                const isActive = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => { setTab(t.id); setSearchQuery(""); }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-all duration-200 rounded-lg"
                    style={{
                      background: isActive ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent',
                      color: isActive ? 'var(--primary)' : 'var(--text-secondary)',
                    }}
                  >
                    <Icon className="w-4 h-4" /> {t.label}
                  </button>
                );
              })}
              {!hasResult && (
                <div className="px-6 py-4 text-xs text-center text-secondary">未找到匹配设置</div>
              )}
            </div>

            <div className="p-3 border-t border-standard">
              <div className="text-[10px] text-center text-tertiary">修改即时保存</div>
            </div>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden min-h-0 bg-surface">
            <div className="flex items-center justify-end px-4 py-3 shrink-0 border-b border-standard">
              <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                <X className="w-4 h-4 text-secondary" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-8 min-h-0 scrollbar-custom flex flex-col items-center">
              <div className="w-full max-w-3xl xl:max-w-5xl 2xl:max-w-7xl">
                {tab === "general" && <GeneralSettings settings={settings} onUpdate={updateSettings} />}
                {tab === "shortcuts" && <ShortcutsSettings />}
                {tab === "providers" && (
                  <div className="space-y-4">
                    <ConfigSourceIndicator />
                    <ProviderConfigPanel providers={providers} onChange={handleProvidersChange} />
                  </div>
                )}
                {tab === "models" && <ModelManager providers={providers} onChange={handleProvidersChange} />}
                {tab === "about" && <AboutSettings />}
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
