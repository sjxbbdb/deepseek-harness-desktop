# DeepSeek Harness 桌面端启动脚本
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
  Write-Host '[dsh-desktop] 首次运行，正在安装依赖...'
  npm install --no-audit --no-fund
}
& (Join-Path $PSScriptRoot 'node_modules\.bin\electron.cmd') .
