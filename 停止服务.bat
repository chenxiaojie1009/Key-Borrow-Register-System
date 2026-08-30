@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Stop Borrow Register System
echo 正在停止借用登记服务（端口 10800）...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":10800 " ^| findstr /c:"LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)
echo 服务已停止。重新启动请双击 start.bat。
pause