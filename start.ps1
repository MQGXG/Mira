param(
    [ValidateSet("dev", "package", "package:win", "package:mac", "package:linux")]
    [string]$mode = "dev"
)

# 修复 PATH：确保 C:\Program Files\nodejs 在 system32 之前（避免 App Installer 占位文件干扰）
$nodePath = "C:\Program Files\nodejs"
$npm = "$nodePath\npm.cmd"
if (Test-Path $npm) {
    $env:Path = "$nodePath;$env:Path"
} else {
    $npm = "npm"
}

# 使用国内镜像加速（国内网络需要）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
& $npm config set registry https://registry.npmmirror.com/ 2>$null

# pnpm workspace 专用安装助手
. .\scripts\install-deps.ps1

function Start-Dev {
    Write-Host "🚀 启动 Mira 桌面应用 (开发模式)..." -ForegroundColor Cyan

    Write-Host "📦 安装前端依赖..." -ForegroundColor Yellow
    Install-Deps -Frozen
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️ lockfile 与 package.json 未同步，回退为普通安装并更新 lockfile..." -ForegroundColor Yellow
        Install-Deps
    }

    Write-Host "`n🖥️  启动 Electron + Vite 热重载..." -ForegroundColor Green
    Write-Host "   按 Ctrl+Shift+I 打开 DevTools" -ForegroundColor Green
    Write-Host "   按 Ctrl+Shift+A 全局唤出`n" -ForegroundColor Green

    & $npm run dev
}

function Start-Package {
    param([string]$target = "")
    Write-Host "📦 打包 Mira..." -ForegroundColor Cyan
    Install-Deps -Frozen
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️ lockfile 与 package.json 未同步，回退为普通安装并更新 lockfile..." -ForegroundColor Yellow
        Install-Deps
    }
    if ($target) {
        & $npm run $target
    } else {
        & $npm run package
    }
    Write-Host "`n✅ 打包完成! 安装包在 release/ 目录" -ForegroundColor Green
}

switch ($mode) {
    "dev"           { Start-Dev }
    "package"       { Start-Package }
    "package:win"   { Start-Package -target "package:win" }
    "package:mac"   { Start-Package -target "package:mac" }
    "package:linux" { Start-Package -target "package:linux" }
    default         { Start-Dev }
}
