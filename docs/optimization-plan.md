# Mira 优化计划 — 参考 4 个外部项目的高价值模式落地

> 状态：**执行中**（M7/M8/M9 ✅，M1–M6 实现未提交） | 基线：Mira 当前主干
> 参考项目：
> - **qwen-audio-agent** `E:\mycodeHub\qwen-audio-agent` — 实时语音 / 后台任务 / 记忆
> - **opencode** `E:\mycodeHub\opencode` — Agent Core 健壮性
> - **mimo-code-Multimodal-integration** `E:\mycodeHub\.mimocode\mimo-code-Multimodal-integration` — 多模态视觉桥
> - **airi** `E:\mycodeHub\airi` — 桌宠嘴型 / 动作动画 / TTS 伪装

执行原则：**一次只改一个模块**，每个模块独立验证 + `pnpm test` / `pnpm typecheck`，不回归再进下一个。

---

## 模块一览

| 模块 | 名称 | 优先级 | 状态 | 参考项目 |
|------|------|--------|------|---------|
| M1 | 桌宠真实嘴型 lip-sync | P0 | 🔲 | airi |
| M4 | 桌宠动作插件管理器 | P0 | 🔲 | airi |
| M2 | 语音插话安全窗口 | P0 | 🔲 | qwen |
| M6-C1 | 工具输出统一截断 | P0 | 🔲 | opencode |
| M3 | turn 世代防串话 | P1 | 🔲 | qwen |
| M5 | 本地 TTS provider 门面 | P1 | 🔲 | airi |
| M6-C2 | doom-loop 死循环检测 | P1 | 🔲 | opencode |
| M6-C3 | MAX_STEPS 软关闭工具 | P1 | 🔲 | opencode |
| M6-C4 | 审批拒绝原因回注 | P1 | ✅ | opencode |
| M7 | 多模态视觉桥 | P2 | ✅ | mimo |
| M8 | 后台任务队列 + 播报 | P2 | ✅ | qwen |
| M9 | 会话记忆自动提取 | P2 | ✅ | qwen |

---

## M1 桌宠真实嘴型 lip-sync

### 现状
`apps/desktop/src/pet/PetApp.tsx:74-77` — 二元硬切：

```ts
const mouth = voiceStatus === "listening" || voiceStatus === "speaking" ? 0.3 : 0
setParameterByName(modelRef.current, "ParamMouthOpenY", mouth)
```

无平滑、无元音分离、无声量驱动，嘴型"机器人"感。

### 参考实现
airi `packages/model-driver-lipsync/src/live2d/index.ts` + `packages/stage-ui-three/src/composables/vrm/lip-sync.ts`：

```
amp = min(vol * 0.9, 1) ** 0.7            # 响度归一化曲线
RAW_KEYS = [A,E,I,O,U,S], S→I             # 元音权重映射
projected[lip] = max(rawVal * amp)        # 重映射
winner + runner 混合:                      # 只混合权重最大的 2 个
  winnerVal 与 runnerVal；target[winner]=min(0.7, val); target[runner]=min(0.35, val*0.6)
静音检测: amp < 0.04 || winnerVal < 0.05 → 160ms 延迟归零
攻/释放平滑: rate = 1 - exp(-(ATTACK|RELEASE) * dt), ATTACK=50 RELEASE=30
```

### 实现要点
参见《M4 手势动画与嘴型》实现文档。

---

## M4 桌宠动作插件管理器

> 依赖：M1 完成后视情况合并或独立。

### 现状
L2 无动作插件化；PetApp 分离度低。

### 参考实现
- airi `packages/stage-ui-live2d/src/composables/live2d/motion-manager.ts`

### 设计（落地）
- 新文件 `apps/desktop/src/pet/motion-manager.ts`：ActionPlugin 接口 `{ kind, name, onAction(action), idle? }`
- SpeechFlow 增加 `plugins` 集合 + `registerPlugin`。
- 转换：插件顶替/叠加到现有代码路径（不被激活）。
- 动作参数映射来自 airi 表 | 参考路径 | 说明 |

---

## M2 语音插话安全窗口

### 现状
无此机制。`voice-session.ts` 无"何时可播"判定。

### 参考实现
qwen `server/src/voice/announcement/announcement-window.mjs`（79 行，已读全文）。核心：

```
isBlocked() = userSpeaking || turnPending || audioResponses.size > 0
responseDone({turnId, origin, hasAudio, hasFunctionCall, suppressed, failed})
queueAudio(responseId) / startPlayback / finishPlayback
interrupt() → turnPending = false
```

### 落地
- 新 `packages/core/src/voice/announcement-window.ts`（TypeScript 直译）
- `voice-session.ts` 接入：`beginTurn` / `endSpeech` / `responseDone` / `queueAudio`
- 后台通知播报（未来 M8）在 `isBlocked()===false` 时开口

---

## M6-C1 工具输出统一截断

### 现状
`packages/core/src/system/tool-materializer.ts` — 仅权限过滤，无输出截断。bash/read_file 大输出直接进上下文。

### 参考实现
opencode `packages/tools-v3/src/tool.ts`（ExecuteResult 自动 truncate）：超 2000 行/50KB 落盘 + preview + metadata 标记。

### 落地
- 在 `settle()` 统一 wrap：对 `{output: string}` 做大小检查，超阈值时：
  - 正文截断到预算，尾部追加 `[truncated, N chars total; full: <data-url or path>]`
  - metadata 增 `truncated:true` + `outputPath`
- 兼容工具已有返回值（保持向后兼容）

---

## M3 turn 世代防串话

### 现状
`interruption.ts` 打断后无"旧结果标记"。

### 落地
- `voice-session.ts` 增 `turnGeneration++`
- `emitEvent('response', ...)` 携带 generation；接收方丢弃 `< current`

---

## M5 本地 TTS provider 门面

### 现状
`packages/ui/src/services/voice/tts.ts` — 已具 `createTTSEngine` 与 local/webspeech，但 `createDefaultTTSEngine` 返回 `webspeech`，且 TTS 插槽/队列未鉴权。

### 参考实现
airi `packages/stage-audio/src/stores/modules/providers/providers/kokoro-local/index.ts` — 本地引擎伪装成 OpenAI-compatible `fetch`。

### 落地
- 让 `createLocalEngine` 暴露与 cloud 相同的 `TTS` 接口（已是）
- `createDefaultTTSEngine` 改为 `local`，失败回退 `webspeech`
- 增 `voice: { type, voice, rate, pitch, volume }` 语义（已有）

---

## 其他模块（P2，方案仅需本文档记录）

### M7 双模态视觉桥
- 参考 mimo `transform.ts:1354-1437` `multimodalBridge()`
- Mira 落点 `packages/core/src/llm/transform.ts`（尚无独立文件，先规划）
- 文本模型遇 image part → 视觉模型描述替换 → 失败回落

### M8 后台任务队列 + 播报
- 参考 qwen `server/src/task/task-manager.mjs`（932 行）
- 依存 M2 announcement-window 播视频

### M9 会话记忆自动提取
- 参考 qwen `memory-extractor.mjs`（247 行）
- 挂会话结束钩子，只写 `stated`，来源标记 `inferred`，敏感内容二次过滤 + 静默失败

---

## 已完成实现（M7 / M8 / M9）

### M7 多模态视觉桥 ✅
- `llm/schema/messages.ts`：新增 `ImagePartSchema`/`ImagePart`（`type:"image"` + `image` + `mediaType?`），加入 `ContentPartSchema` union，新增 `isImagePart`。
- 新建 `llm/transform.ts`：`collectImages`/`hasImageContent`/`modelHasVision`/`multimodalBridge`；`createVisionRuntime` 懒加载 `./client` 防循环依赖。
- `llm/client.ts`：`SDKConfig` 新增 `visionModel?`；`innerStream` 开头触发桥（`bridgeMessages`），失败 `console.warn` 回落不阻断。
- 协议层 image 序列化：openai-chat `image_url` blocks；anthropic-messages `source base64/url`（data URL 正则解析）；gemini `inlineData`/`fileData`。
- 配置穿透：`AgentConfig.visionModel`（constants）→ `LLMTurnConfig.visionModel`（turn）→ `TurnRunnerInput` / agent turnInput。
- 测试：`__tests__/transform-multimodal.test.ts`（12 用例）。

### M8 后台任务播报
- 新建 `background/notifier.ts`：`BackgroundNotifier`（FIFO + `AnnouncementWindow` 门控 + markDelivered/retry/pendingCount/list/prune）。
- `background/index.ts`：导出 notifier + 全局注入 `backgroundNotifier`/`setBackgroundNotifier`；`startBackground` 完成自动 `addTaskResult`。`cron.ts` tick 后同样播报。
- 测试：`__tests__/background-notifier.test.ts`（11 用例）。

### M9 会话记忆自动提取
- 新建 `memory/memory-extractor.ts`：`MemoryExtractor`（注入 `store`/`listMessages`/`llmCall`/`now`，`maybeRun` fire-and-forget 永不 reject）、`parseOps`/`cleanFact`/`transcriptLines`/`containsSensitiveContent`、`createExtractorLlmCall`（懒加载 `createLLMClient`）、模块级 `sessionMemoryExtractor` + `runSessionMemoryExtraction`。
- 安全不变量：只写 `stated`、敏感内容二次过滤（绝不回显被拒密）、去重（已有记忆 + 本次写入）、上限 5 条/run、失败静默。
- `memory/fts-memory-provider.ts`：新增 `remember(content, sessionID, source="inferred")` 与 `listMemories(sessionID?, limit?)`。
- `agent/agent.ts` `finalizeRun`：会话收尾时调用 `maybeExtractSessionMemory`（懒建 llmCall，失败静默不阻断）。
- `index.ts` 导出全部公共 API。
- 测试：`__tests__/memory-extractor.test.ts`（16 用例）。

> **M1–M6 提示**：以上三模块的落地文件均已提交前回归验证（core 全量 399 passed、typecheck 干净）。M1–M6 系列实现（voice/lip-sync、doom-loop、turn-classifier、truncate、generation、announcement-window 等 43 文件 / 415 测试）仍在工作区未提交。

---

## 执行顺序

```
M1 → M4 → M2 → M6-C1 → (M3, M5 依并行) → ... → P2 模块
```

Each module: 独立 commit、独立测试、验收后置下一。