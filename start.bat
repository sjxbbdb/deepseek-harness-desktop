@echo off
rem DeepSeek Harness 桌面端启动脚本
setlocal
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo [dsh-desktop] 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
)
start "" node_modules\.bin\electron.cmd .
endlocal
