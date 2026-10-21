# verify-install.ps1 — 核对已安装的桌面端版本与内置运行时
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-install.ps1 -Root "D:\apps\DeepSeek Harness Desktop"
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness Desktop')
)

$ErrorActionPreference = 'Continue'
$res = Join-Path $Root 'resources'
$exe = Join-Path $Root 'DeepSeek Harness Desktop.exe'

function Get-JsonVersion([string]$pkgPath) {
  if (-not (Test-Path -LiteralPath $pkgPath)) { return '(缺失)' }
  try { return (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).version } catch { return '(读取失败)' }
}

Write-Host '=== dsh-desktop 安装核对 ==='
Write-Host "安装目录 : $Root"

if (Test-Path -LiteralPath $exe) {
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  Write-Host "桌面端   : $($vi.ProductVersion)（FileVersion $($vi.FileVersion)）"
} else {
  Write-Host '桌面端   : (未找到 exe)'
}

$dshPkg = Join-Path $res 'dsh\node_modules\@deepseek-ai\dsh\package.json'
$dshVer = Get-JsonVersion $dshPkg
$dshBin = Join-Path $res 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
Write-Host "内置 dsh : $dshVer（bin.js 存在: $(Test-Path -LiteralPath $dshBin)）"

$nodeExe = Join-Path $res 'node\node.exe'
if (Test-Path -LiteralPath $nodeExe) {
  Write-Host "内置 node: $(& $nodeExe --version)"
} else {
  Write-Host '内置 node: (缺失)'
}

$asar = Join-Path $res 'app.asar'
if (Test-Path -LiteralPath $asar) {
  $a = Get-Item -LiteralPath $asar
  Write-Host "app.asar : $($a.Length) 字节，$($a.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
} else {
  Write-Host 'app.asar : (缺失)'
}

Write-Host ''
Write-Host '=== 运行中的进程 ==='
$procs = Get-Process -Name 'DeepSeek Harness Desktop' -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Select-Object Id, StartTime, Path | Format-Table -AutoSize | Out-String | Write-Host
} else {
  Write-Host '(应用未运行)'
}

Write-Host '=== 启动日志（最后 8 行） ==='
$log = Join-Path $env:APPDATA 'dsh-desktop\logs\desktop.log'
if (Test-Path -LiteralPath $log) {
  Get-Content -LiteralPath $log -Tail 8 -Encoding UTF8
} else {
  Write-Host "(无日志: $log)"
}

Write-Host ''
Write-Host '提示：设置 → 通用设置 →「关于 dsh-desktop」也应显示同样的桌面端 / dsh / Node 版本。'
