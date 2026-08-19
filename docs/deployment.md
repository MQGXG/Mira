# Mira 部署文档

## 开发环境

### 前置要求

- Node.js 18+
- pnpm 8+
- Windows / macOS / Linux
- **无需 Python**

### 启动开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev
```

### 环境变量

复制 `.env.example` 为 `.env`，填入 API Key：

```bash
MIRA_API_KEY=sk-xxx
MIRA_PROVIDER=openai
MIRA_MODEL=gpt-4o
MIRA_API_URL=https://api.openai.com/v1
MIRA_MODE=assistant
```

## 打包部署

### Windows

```bash
pnpm package:win
# 生成 release/Mira-Setup-1.0.0.exe
# Windows NSIS 安装包
```

### macOS

```bash
pnpm package:mac
# 生成 release/Mira-1.0.0.dmg
```

### Linux

```bash
pnpm package:linux
# 生成 release/Mira-1.0.0.AppImage
```

## 分发

### 分发形式

Mira 使用 electron-builder：Windows 为 NSIS 安装包，macOS 为 DMG，Linux 为 AppImage。目标电脑无需安装 Node.js 等运行时。

### 数据目录

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%/Mira/` |
| macOS | `~/Library/Application Support/Mira/` |
| Linux | `~/.config/Mira/` |

包含：
- `config.json` — 全局配置
- `mira.db` — SQLite 数据库
- `logs/` — 日志文件

## 配置

### 全局配置

全局配置位于 Electron `app.getPath("userData")` 目录下的 `config.json`。Windows 通常为 `%APPDATA%/Mira/config.json`；macOS 和 Linux 路径以 Electron 运行时返回值为准：

```json
{
  "provider": "openai",
  "model": "gpt-4",
  "apiKey": "sk-xxx",
  "maxSteps": 50,
  "maxContextTokens": 128000
}
```

### 项目配置

`{workspace}/mira.json`：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "maxSteps": 100
}
```

### 环境变量引用

配置值支持环境变量引用：

```json
{
  "apiKey": "{env:OPENAI_API_KEY}"
}
```

## 故障排除

### 日志位置

- Windows: `%APPDATA%/Mira/logs/mira-YYYY-MM-DD.log`
- macOS: `~/Library/Application Support/Mira/logs/mira-YYYY-MM-DD.log`
- Linux: `~/.config/Mira/logs/mira-YYYY-MM-DD.log`

### 常见问题

**应用无法启动**
- 检查 Node.js 版本是否 >= 18
- 查看日志文件获取详细错误信息

**API 调用失败**
- 检查 API Key 是否正确配置
- 检查网络连接
- 查看日志中的错误详情

**Playwright 未安装**
```bash
npx playwright install chromium
```

## 更新

1. 下载最新版本
2. 替换旧的可执行文件
3. 数据目录自动保留，无需迁移
