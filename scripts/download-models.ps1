# 下载本地 AI 模型（Transformers.js ONNX 格式）到 resources/models/
# 打包时通过 electron-builder extraResources 随应用分发；缺失时应用会在运行时自动在线下载兜底。
#
# 用法（在项目根目录）:
#   . .\scripts\download-models.ps1; Invoke-DownloadModels
#   可选环境变量：
#     MIRA_HF_MIRROR=1    使用国内镜像 hf-mirror.com（默认自动探测）
#     MIRA_MODELS_DIR=... 自定义输出目录（默认 .\resources\models）
#
# 当前收录模型（含量化 q8，体积最小）：
#   - Xenova/bge-small-zh-v1.5   中文语义嵌入模型（记忆图谱向量检索），约 24MB

$script:Models = @(
    @{
        Repo  = "Xenova/bge-small-zh-v1.5"
        Files = @(
            @{ Path = "config.json";                 Required = $true }
            @{ Path = "tokenizer_config.json";       Required = $true }
            @{ Path = "tokenizer.json";              Required = $true }
            @{ Path = "special_tokens_map.json";     Required = $false }
            @{ Path = "vocab.txt";                   Required = $false }
            @{ Path = "onnx/model_quantized.onnx";   Required = $true }
        )
    }
)

function Get-HfBase {
    if ($env:MIRA_HF_MIRROR -eq "1") { return "https://hf-mirror.com" }
    # 自动探测：优先官方 Hub，失败回退国内镜像
    try {
        $resp = Invoke-WebRequest -Uri "https://huggingface.co" -Method Head -TimeoutSec 8 -UseBasicParsing
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { return "https://huggingface.co" }
    } catch { }
    Write-Host "⚠️  官方 Hugging Face 不可达，切换国内镜像 hf-mirror.com" -ForegroundColor Yellow
    return "https://hf-mirror.com"
}

function Invoke-DownloadModels {
    param(
        [string]$OutputDir = (Join-Path (Get-Location) "resources\models"),
        [string[]]$RepoFilter = @()
    )

    $base = Get-HfBase
    Write-Host "📦 模型下载源: $base" -ForegroundColor Cyan
    Write-Host "📂 输出目录: $OutputDir" -ForegroundColor Cyan

    foreach ($model in $script:Models) {
        if ($RepoFilter.Count -gt 0 -and $RepoFilter -notcontains $model.Repo) { continue }

        $modelRoot = Join-Path $OutputDir $model.Repo.Replace("/", "\")
        Write-Host "`n⬇️  下载模型: $($model.Repo)" -ForegroundColor Green

        foreach ($file in $model.Files) {
            $dest = Join-Path $modelRoot $file.Path.Replace("/", "\")
            if (Test-Path -LiteralPath $dest) {
                Write-Host "  ✔ 已存在，跳过: $($file.Path)" -ForegroundColor DarkGray
                continue
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            $url = "$base/$($model.Repo)/resolve/main/$($file.Path)"
            Write-Host "  ⏳ $($file.Path) ..." -ForegroundColor Gray
            try {
                Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 300 -UseBasicParsing
                Write-Host "  ✔ 完成: $($file.Path)" -ForegroundColor Green
            } catch {
                if ($file.Required) {
                    Write-Host "  ❌ 失败（必需文件）: $($file.Path): $($_.Exception.Message)" -ForegroundColor Red
                    throw
                }
                Write-Host "  ⚠️  跳过（非必需）: $($file.Path)" -ForegroundColor Yellow
            }
        }
    }

    Write-Host "`n✅ 模型下载完成。打包时 extraResources 会将其复制到安装目录 resources/models。" -ForegroundColor Green
}

# 便于 . .\scripts\download-models.ps1 后直接调用
