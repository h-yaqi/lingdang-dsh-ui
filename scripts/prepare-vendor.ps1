# prepare-vendor.ps1 — 准备打包所需的内置运行时
#
# 生成 vendor/ 目录（已被 .gitignore 排除，按需重新生成）：
#   vendor/node/node.exe                    内置 Node 运行时（与系统版本一致，保证原生模块 ABI 兼容）
#   vendor/dsh/node_modules/...             dsh CLI 完整依赖闭包
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-vendor.ps1
#   npm run prepare:vendor
#
# 可选参数：
#   -DshRoot <path>    dsh CLI 的 node_modules 父目录（默认自动解析：where dsh → npx 缓存）

param(
  [string]$DshRoot = "",
  [string]$NodeVersion = "24.19.0"
)

$ErrorActionPreference = "Stop"
$ws = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $ws "vendor"
$nodeDir = Join-Path $vendor "node"
$dshDir = Join-Path $vendor "dsh"
$nodeExe = Join-Path $nodeDir "node.exe"

# ---------- 1. 内置 Node ----------
if (Test-Path $nodeExe) {
  Write-Host "[vendor] node.exe 已存在: $nodeExe"
} else {
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  $zip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
  $url = "https://npmmirror.com/mirrors/node/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  Write-Host "[vendor] 下载 $url ..."
  & node -e "const fs=require('fs');const u=process.argv[1],z=process.argv[2];fetch(u,{signal:AbortSignal.timeout(300000)}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);fs.writeFileSync(z,Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})" $url $zip
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
  $entry = $archive.Entries | Where-Object { $_.FullName -match "node\.exe$" } | Select-Object -First 1
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodeExe, $true)
  $archive.Dispose()
  Remove-Item $zip -ErrorAction SilentlyContinue
  Write-Host "[vendor] node.exe 就绪"
}

# ---------- 2. 内置 dsh CLI ----------
if (Test-Path (Join-Path $dshDir "node_modules\@deepseek-ai\dsh\lib\bin.js")) {
  Write-Host "[vendor] dsh CLI 已存在: $dshDir"
} else {
  if (-not $DshRoot) {
    $shim = (& where.exe dsh 2>$null | Where-Object { $_ -match "\.cmd$" } | Select-Object -First 1)
    if ($shim) {
      $DshRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $shim)) "node_modules"
    }
  }
  if (-not $DshRoot -or -not (Test-Path (Join-Path $DshRoot "@deepseek-ai\dsh\lib\bin.js"))) {
    $npx = Join-Path $env:USERPROFILE "AppData\Local\npm-cache\_npx"
    if (Test-Path $npx) {
      $hit = Get-ChildItem $npx -Directory | ForEach-Object {
        $cand = Join-Path $_.FullName "node_modules\@deepseek-ai\dsh\lib\bin.js"
        if (Test-Path $cand) { Join-Path $_.FullName "node_modules" }
      } | Select-Object -First 1
      if ($hit) { $DshRoot = $hit }
    }
  }
  if (-not $DshRoot -or -not (Test-Path (Join-Path $DshRoot "@deepseek-ai\dsh\lib\bin.js"))) {
    throw "未找到 dsh CLI 依赖闭包，请先安装 @deepseek-ai/dsh，或用 -DshRoot 指定其 node_modules 目录"
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $dshDir "node_modules") | Out-Null
  Write-Host "[vendor] 复制 dsh 依赖闭包: $DshRoot -> $dshDir\node_modules (约 190MB，请稍候) ..."
  & robocopy $DshRoot (Join-Path $dshDir "node_modules") /E /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy 失败: $LASTEXITCODE" }
  Write-Host "[vendor] dsh CLI 就绪"
}

Write-Host "[vendor] 完成: $vendor"
