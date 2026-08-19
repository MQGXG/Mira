# 共享依赖安装助手
# 项目为 pnpm workspace（pnpm-workspace.yaml），必须用 pnpm 安装 —— npm install 不会正确解析 workspace。
# 优先使用全局 pnpm；若不在 PATH，回退到 Node 自带的 corepack。
# 用法（在项目根目录）: . .\scripts\install-deps.ps1; Install-Deps [-Frozen]

function Install-Deps {
    param([switch]$Frozen)

    $argsList = @("install")
    if ($Frozen) { $argsList += "--frozen-lockfile" }

    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpm) {
        & $pnpm.Source @argsList
        return
    }

    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) {
        & $corepack.Source pnpm @argsList
        return
    }

    Write-Host "❌ 未找到 pnpm，请先执行: npm install -g pnpm" -ForegroundColor Red
    exit 1
}
