import { ipcMain } from "electron"
import { getConfigForRenderer, saveGlobalConfig, ProviderCatalog, VoiceRegistry, initVoiceCatalog, saveUserVoiceDefaults } from "@mira/core"

export function registerConfigIPC(): void {
  ipcMain.handle("config:get", (_, workspace?: string) => {
    return getConfigForRenderer(workspace)
  })
  ipcMain.handle("config:save", (_, config: Record<string, unknown>) => {
    saveGlobalConfig(config)
  })
  ipcMain.handle("config:getProviderCatalog", () => {
    if (!ProviderCatalog.isInitialized()) ProviderCatalog.initProviderCatalog()
    return ProviderCatalog.getCatalogForUI()
  })
  // 语音引擎目录（一切皆插件）：内置 + 用户 voice.json + 插件注册的最终目录与默认选中项
  ipcMain.handle("config:getVoiceCatalog", () => {
    initVoiceCatalog()
    return { catalog: VoiceRegistry.listCatalog(), defaults: VoiceRegistry.getDefaults() }
  })
  // 保存默认引擎选中项到 ~/.config/mira/voice.json（只写 defaults，不动 ui 开关）
  ipcMain.handle("config:saveVoiceConfig", (_, defaults: Record<"stt" | "tts" | "vad" | "dictation", string | undefined>) => {
    initVoiceCatalog()
    saveUserVoiceDefaults(defaults || {})
    VoiceRegistry.setDefaults(defaults || {})
  })
}

