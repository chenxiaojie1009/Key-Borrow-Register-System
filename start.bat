@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Borrow Register System

where node >nul 2>&1
if errorlevel 1 goto NO_NODE

netstat -ano | findstr /c:":10800 " | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 goto ALREADY

echo 正在后台静默启动服务（无窗口），请稍候...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
timeout /t 3 /nobreak >nul

netstat -ano | findstr /c:":10800 " | findstr /c:"LISTENING" >nul 2>&1
if errorlevel 1 goto FAIL

echo 服务启动成功，正在打开浏览器...
start "" "http://localhost:10800"
goto END

:ALREADY
echo 服务已在运行，直接打开浏览器...
start "" "http://localhost:10800"
goto END

:NO_NODE
echo ==========================================================
echo   [错误] 未检测到 Node.js（node 命令不可用）。
echo   请先在电脑上安装 Node.js 长期支持版(LTS)：
echo   打开网址下载并安装：https://nodejs.org/zh-cn/download
echo   安装时务必勾选 "Add to PATH"，安装完成后重新双击本文件。
echo ==========================================================
pause
goto END

:FAIL
echo ==========================================================
echo   [失败] 服务未能在 3 秒内启动。
echo   请打开与 start.bat 同目录下的 server-err.log 查看原因。
echo   常见原因：
echo     1) 端口 10800 被其他程序占用（可先双击 停止服务.bat）
echo     2) Node.js 版本过低（需 v18 及以上）
echo   排障后可重新双击本文件。
echo ==========================================================
pause
goto END

:END
endlocal