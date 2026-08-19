# 安全策略

## API Key 保护

- API Key 使用 **Electron safeStorage** 加密后存储在 `localStorage`
- 加密前缀 `enc:` 标识已加密的 Key
- 支持从环境变量（`OPENAI_API_KEY` 等）和配置文件加载，无需在界面填写

## 权限系统

Agent 执行敏感操作（文件读写、Shell 命令、网络请求）时触发权限确认：

| 权限级别 | 行为 |
|----------|------|
| 拒绝 | 阻止本次操作 |
| 允许 | 允许本次操作 |
| 始终允许 | 信任该工具，后续自动放行 |

可在设置中启用「自动接受权限」跳过确认。

硬拒绝列表（不可覆盖）：
- `rm -rf /`, `rm -rf /*`
- `sudo`
- `shutdown`, `reboot`
- `mkfs`, `dd if=`
- fork bomb (`:(){ :|:& };:`)

## 数据存储

| 数据类型 | 存储位置 | 加密 |
|----------|----------|------|
| 会话消息 | `mira.db` (SQLite) | 明文 |
| 向量数据 | `vector-memory/` (Transformers.js) | 明文 |
| API Key | localStorage | safeStorage 加密 |
| 设置偏好 | `config.json` | 明文 |
| 项目记忆 | `.mira/knowledge/` | 明文 |

## 网络安全

- 所有 LLM API 调用通过 Electron 主进程，前端不直接暴露
- MCP 服务器连接经过配置验证
- 无外部 CDN 依赖，资源全部本地加载

## 权限规则

声明式权限系统支持通配符匹配：

```typescript
{ action: "bash", resource: "ls *", effect: "allow" }  // 允许 ls 命令
{ action: "bash", resource: "*", effect: "ask" }       // 其他命令需确认
{ action: "write_file", resource: "*", effect: "ask" } // 写文件需确认
```

## 报告漏洞

如发现安全漏洞，请通过 GitHub Issues 报告，避免公开披露。
