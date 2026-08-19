param(
    [switch]$full
)

Write-Host "=== Mira 环境设置 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js（需 >= 18，自带 corepack）
$npmPath = "C:\Program Files\nodejs\npm.cmd"
if (-not (Test-Path $npmPath)) {
    Write-Host "❌ 未找到 Node.js，请从 https://nodejs.org 安装" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Node.js 已安装" -ForegroundColor Green

# 2. 安装前端依赖（pnpm workspace，必须用 pnpm 而非 npm）
. .\scripts\install-deps.ps1
Write-Host "📦 安装前端依赖..." -ForegroundColor Yellow
Install-Deps -Frozen
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ lockfile 与 package.json 未同步，回退为普通安装并更新 lockfile..." -ForegroundColor Yellow
    Install-Deps
}
Write-Host "✅ 前端依赖已安装" -ForegroundColor Green

# 3. 摘要
Write-Host ""
Write-Host "=== 设置完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "启动命令: .\start.ps1 dev" -ForegroundColor Green
Write-Host "打包命令: .\start.ps1 package:win" -ForegroundColor Green
