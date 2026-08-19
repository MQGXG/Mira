import { useEffect, useState } from "react"
import { ThemeSelector } from "../ThemeSelector";
import { Switch } from "../../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { DialogService } from "../../services/dialog.service";
import { loadProviders } from "../provider-data";
import { loadVoiceCatalog, saveVoiceDefaults as persistVoiceDefaults } from "../../services/voice/engine-registry";
import type { VoiceEngineDef } from "@mira/core/voice";
import type { Provider } from "../types";

interface Props {
  settings: Record<string, any>;
  onUpdate: (patch: Record<string, any>) => void;
}

function useModelList() {
  const [models, setModels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("pet_models") || '{"hiyori":"./models/hiyori/Hiyori.model3.json"}') as Record<string, string> }
    catch { return { hiyori: "./models/hiyori/Hiyori.model3.json" } }
  })
  const save = (m: Record<string, string>) => {
    localStorage.setItem("pet_models", JSON.stringify(m))
    setModels(m)
  }
  const add = (key: string, path: string) => {
    if (!key || !path || models[key]) return
    save({ ...models, [key]: path })
  }
  const remove = (key: string) => {
    if (key === "hiyori") return
    const { [key]: _, ...rest } = models
    save(rest)
  }
  return { models, add, remove }
}

const timelineSettings = [
  { key: "showReasoning", label: "显示推理摘要", desc: "在时间线中显示模型推理摘要" },
  { key: "expandShellTools", label: "展开 Shell 工具", desc: "默认在时间线中展开 shell 工具部分" },
  { key: "expandEditTools", label: "展开编辑工具", desc: "默认在时间线中展开 edit、write 和 patch 工具部分" },
] as const;

const toggleSettings = [
  { key: "maxMode", label: "增强模式（Max Mode）", desc: "并行生成多个候选方案，选最优执行。提升复杂任务质量，但消耗更多 token" },
  { key: "showProgressBar", label: "显示会话进度条", desc: "当智能体正在工作时，在会话顶部显示动画进度条" },
] as const;

export function GeneralSettings({ settings, onUpdate }: Props) {
  const { models, add, remove } = useModelList()
  const [newKey, setNewKey] = useState("")
  const [newPath, setNewPath] = useState("")

  // ── 语音引擎目录（一切皆插件：内置 + 用户 voice.json + 插件注册） ──
  const [voiceCatalog, setVoiceCatalog] = useState<{ catalog: VoiceEngineDef[]; defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>> } | null>(null)
  useEffect(() => {
    void loadVoiceCatalog().then(setVoiceCatalog).catch(() => {})
  }, [])
  const saveVoiceDefaults = async (patch: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>) => {
    await persistVoiceDefaults(patch)
    setVoiceCatalog((v) => (v ? { ...v, defaults: { ...v.defaults, ...patch } } : v))
  }
  const sttEngines = voiceCatalog?.catalog.filter((e) => e.kind === "stt") ?? []
  const ttsEngines = voiceCatalog?.catalog.filter((e) => e.kind === "tts") ?? []

  // ── 视觉桥模型选项（已启用 + 含 vision 模型的 provider） ──
  const [visionProviders, setVisionProviders] = useState<Provider[]>([])
  useEffect(() => { void loadProviders().then(setVisionProviders).catch(() => {}) }, [])

  const override = settings.visionModelOverride
    ? { provider: settings.visionModelOverride.provider as string, model: settings.visionModelOverride.model as string }
    : null
  // 视觉桥模型：不限定内置白名单，允许用户选择任意已启用 provider 的任意已启用模型
  //（例如智谱 GLM-4V-Flash、GLM-4.6V-Flash 等未列入内置清单的视觉模型）
  const visionProviderOptions = visionProviders.filter((p) => p.enabled && p.models.some((m) => m.enabled))
  const currentVisionProvider = visionProviderOptions.find((p) => (p.id.startsWith("custom-") ? "custom" : p.id) === override?.provider)
  const visionModelOptions = currentVisionProvider
    ? currentVisionProvider.models.filter((m) => m.enabled)
    : []
  const setOverride = (provider: string, model: string) => onUpdate({ visionModelOverride: provider ? { provider, model } : null })

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-primary">通用设置</h3>
      <ThemeSelector />

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">权限</div>
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-sm text-primary">自动接受权限</div>
            <div className="text-xs mt-0.5 text-secondary">允许 Agent 自动执行操作，不再弹出确认对话框</div>
          </div>
          <Switch checked={settings.autoAcceptPermissions}
            onCheckedChange={(v) => onUpdate({ autoAcceptPermissions: v })} />
        </label>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">终端</div>
        <label className="text-xs mb-1 block text-secondary">默认 Shell</label>
        <Select value={settings.terminalShell}
          onValueChange={(v) => onUpdate({ terminalShell: v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Auto (Default)</SelectItem>
            <SelectItem value="powershell">PowerShell</SelectItem>
            <SelectItem value="cmd">CMD</SelectItem>
            <SelectItem value="bash">Bash (WSL)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">时间线</div>
        <div className="space-y-3">
          {timelineSettings.map((item) => (
            <label key={item.key} className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-sm text-primary">{item.label}</div>
                <div className="text-xs text-secondary">{item.desc}</div>
              </div>
              <Switch checked={settings[item.key]}
                onCheckedChange={(v) => onUpdate({ [item.key]: v })} />
            </label>
          ))}
        </div>
      </div>

      {toggleSettings.map((item) => (
        <div key={item.key} className="p-4 rounded-xl bg-surface-secondary border border-standard">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm text-primary">{item.label}</div>
              <div className="text-xs mt-0.5 text-secondary">{item.desc}</div>
            </div>
            <Switch checked={settings[item.key]}
              onCheckedChange={(v) => onUpdate({ [item.key]: v })} />
          </label>
        </div>
      ))}

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-sm text-primary">AI 生成追问建议</div>
            <div className="text-xs mt-0.5 text-secondary">每条回复后由模型生成贴合内容的追问建议；关闭则使用本地规则。会消耗少量 token</div>
          </div>
          <Switch checked={settings.followUpLlm !== false}
            onCheckedChange={(v) => onUpdate({ followUpLlm: v })} />
        </label>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">语音</div>
        <label className="flex items-center justify-between cursor-pointer mb-3">
          <div>
            <div className="text-sm text-primary">实时语音对话</div>
            <div className="text-xs mt-0.5 text-secondary">语音对话模式：说话→识别→回复→朗读（默认本地引擎，离线可用）</div>
          </div>
          <Switch checked={settings.voiceChatEnabled !== false}
            onCheckedChange={(v) => onUpdate({ voiceChatEnabled: v })} />
        </label>
        <div className="mb-3">
          <label className="text-xs mb-1 block text-secondary">识别引擎（STT）</label>
          <Select value={voiceCatalog?.defaults.stt ?? ""}
            onValueChange={(v) => void saveVoiceDefaults({ stt: v, dictation: v })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="默认" />
            </SelectTrigger>
            <SelectContent>
              {sttEngines.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] mt-1 text-secondary">听写（按住说话）默认跟随识别引擎</p>
        </div>
        <div>
          <label className="text-xs mb-1 block text-secondary">朗读引擎（TTS）</label>
          <Select value={voiceCatalog?.defaults.tts ?? ""}
            onValueChange={(v) => void saveVoiceDefaults({ tts: v })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="默认" />
            </SelectTrigger>
            <SelectContent>
              {ttsEngines.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] mt-1 text-secondary">本地引擎首次使用需下载模型（约 80MB），之后可离线朗读</p>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">默认工作目录</div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={settings.defaultWorkspace || ""}
              placeholder="未设置，使用系统默认（文档目录/Mira）"
              className="h-8 text-xs flex-1"
            />
            <button
              type="button"
              onClick={async () => {
                const dirs = await DialogService.openDirectory();
                if (dirs && dirs.length > 0) onUpdate({ defaultWorkspace: dirs[0] });
              }}
              className="px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{ background: "var(--bg-tertiary)", color: "var(--fg)" }}
            >
              浏览
            </button>
            {settings.defaultWorkspace && (
              <button
                type="button"
                onClick={() => onUpdate({ defaultWorkspace: "" })}
                className="px-3 py-1.5 rounded-lg text-xs transition-colors"
                style={{ color: "var(--fg-tertiary)" }}
              >
                恢复默认
              </button>
            )}
          </div>
          <p className="text-[11px] text-secondary">新建/打开项目时的默认目录；留空使用系统默认（文档目录/Mira）</p>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">图片识别（多模态视觉桥）</div>
        <div className="space-y-3">
          <p className="text-[11px] text-secondary">
            当前模型不支持识别图片时，系统会自动从已配置的模型中找一个支持视觉的模型来分析图片（无需手动配置）。
            如需指定，可在下方选择。
          </p>
          {visionProviderOptions.length > 0 ? (
            <>
              <div>
                <label className="text-xs mb-1 block text-secondary">视觉模型（留空自动选择）</label>
                <div className="flex items-center gap-2">
                  <Select value={override?.provider || ""}
                    onValueChange={(v) => {
                      const prov = visionProviderOptions.find((p) => (p.id.startsWith("custom-") ? "custom" : p.id) === v)
                      const firstModel = prov?.models.find((m) => m.enabled)
                      setOverride(v, firstModel?.id || "")
                    }}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="自动" />
                    </SelectTrigger>
                    <SelectContent>
                      {visionProviderOptions.map((p) => {
                        const pid = p.id.startsWith("custom-") ? "custom" : p.id
                        return <SelectItem key={pid} value={pid}>{p.displayName || p.name}</SelectItem>
                      })}
                    </SelectContent>
                  </Select>
                  {override?.provider && (
                    <Select value={override.model}
                      onValueChange={(v) => setOverride(override.provider, v)}>
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {visionModelOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {override?.provider && (
                    <Button variant="ghost" size="sm" onClick={() => setOverride("", "")} className="text-[11px] shrink-0">
                      恢复自动
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-secondary">
              未检测到已启用的提供商模型。请先在「提供商」中启用并配置至少一个模型。
            </p>
          )}
        </div>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">桌面悬浮球</div>
        <div className="space-y-3">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm text-primary">启用悬浮球</div>
              <div className="text-xs mt-0.5 text-secondary">在桌面显示常驻悬浮球，点击展开聊天面板</div>
            </div>
            <Switch checked={settings.floatingBallEnabled !== false}
              onCheckedChange={(v) => {
                onUpdate({ floatingBallEnabled: v })
                window.electronAPI?.floatingBall?.toggle(v)
                if (v) {
                  window.electronAPI?.floatingBall?.updateConfig({
                    autoHideTimeout: (settings.floatingBallAutoHideSeconds || 60) * 1000,
                    shortcut: settings.floatingBallShortcut || "CommandOrControl+Shift+M",
                  })
                }
              }} />
          </label>
          {settings.floatingBallEnabled !== false && (
            <>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm text-primary">自动隐藏</div>
                  <div className="text-xs mt-0.5 text-secondary">无操作时自动隐藏悬浮球</div>
                </div>
                <Switch checked={settings.floatingBallAutoHide !== false}
                  onCheckedChange={(v) => {
                    onUpdate({ floatingBallAutoHide: v })
                    window.electronAPI?.floatingBall?.updateConfig({
                      autoHideTimeout: (settings.floatingBallAutoHideSeconds || 60) * 1000,
                    })
                  }} />
              </label>
              <div>
                <label className="text-xs mb-1 block text-secondary">隐藏超时（秒）</label>
                <Input 
                  type="number" 
                  min={10}
                  max={300}
                  value={settings.floatingBallAutoHideSeconds || 60}
                  onChange={(e) => {
                    const v = parseInt(e.target.value) || 60
                    onUpdate({ floatingBallAutoHideSeconds: v })
                    window.electronAPI?.floatingBall?.updateConfig({ autoHideTimeout: v * 1000 })
                  }} 
                  className="h-8 text-xs" 
                />
              </div>
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm text-primary">显示快捷键</div>
                  <div className="text-xs mt-0.5 text-secondary">全局快捷键唤出悬浮球</div>
                </div>
                <Input 
                  value={settings.floatingBallShortcut || "CommandOrControl+Shift+M"}
                  onChange={(e) => onUpdate({ floatingBallShortcut: e.target.value })} 
                  className="w-40 h-8 text-xs" 
                />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="p-4 rounded-xl bg-surface-secondary border border-standard">
        <div className="text-sm mb-3 text-primary">Live2D 桌宠</div>
        <div className="space-y-3">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm text-primary">启用桌宠</div>
              <div className="text-xs mt-0.5 text-secondary">在桌面显示 Live2D 角色，支持直接对话</div>
            </div>
            <Switch checked={settings.live2dPet}
              onCheckedChange={(v) => {
                onUpdate({ live2dPet: v })
                window.electronAPI?.live2d?.toggle(v)
              }} />
          </label>
          {settings.live2dPet && (
            <>
              <div>
                <label className="text-xs mb-1 block text-secondary">角色模型</label>
                <Select value={settings.petModel || "hiyori"}
                  onValueChange={(v) => {
                    onUpdate({ petModel: v })
                    localStorage.setItem("pet_model", v)
                  }}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(models).map(([key, path]) => (
                      <SelectItem key={key} value={key}>
                        {key}{key === "hiyori" ? "（默认）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-xs mb-1 block text-secondary">添加模型</label>
                  <Input placeholder="名称（如 my-model）" value={newKey}
                    onChange={(e) => setNewKey(e.target.value)} className="h-8 text-xs" />
                </div>
                <div className="flex-1">
                  <Input placeholder="路径（如 /models/xxx/model3.json）" value={newPath}
                    onChange={(e) => setNewPath(e.target.value)} className="h-8 text-xs" />
                </div>
                <Button size="sm" onClick={() => { add(newKey, newPath); setNewKey(""); setNewPath("") }}>
                  添加
                </Button>
              </div>
              {Object.keys(models).length > 1 && (
                <div className="text-xs text-tertiary space-y-1">
                  {Object.keys(models).filter(k => k !== "hiyori").map(k => (
                    <div key={k} className="flex items-center justify-between">
                      <span>{k}</span>
                      <Button variant="ghost" size="sm" onClick={() => remove(k)}
                        className="text-red-400 hover:text-red-300 !h-auto !px-1 !text-xs">删除</Button>
                    </div>
                  ))}
                </div>
              )}
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm text-primary">关闭主窗口时关闭桌宠</div>
                  <div className="text-xs mt-0.5 text-secondary">关闭主应用窗口时同时关闭桌宠窗口</div>
                </div>
                <Switch checked={settings.closePetWithApp}
                  onCheckedChange={(v) => onUpdate({ closePetWithApp: v })} />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
