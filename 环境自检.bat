@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 借用登记系统 - 环境自检
echo ==========================================================
echo   借用登记系统 环境自检
echo ==========================================================
echo.
echo [1/3] 检查 Node.js ...
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] 未找到 node 命令 - 请安装 Node.js LTS 并勾选 Add to PATH
) else (
  echo   [OK] 已找到 Node.js，版本：
  node -v
)
echo.
echo [2/3] 检查端口 10800 ...
netstat -ano | findstr /c:":10800 " | findstr /c:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo   [OK] 端口空闲，可以启动
) else (
  echo   [!] 端口已被占用（可能有旧服务在运行），请先双击 停止服务.bat
)
echo.
echo [3/3] 检查程序文件 ...
if exist server.js ( echo   [OK] server.js 存在 ) else ( echo   [X] 缺少 server.js，请重新解压完整包 )
if exist node_modules\express ( echo   [OK] 依赖文件完整 ) else ( echo   [X] 缺少 node_modules，请重新解压完整包 )
echo.
echo ==========================================================
echo   自检完成。全部 [OK] 即可双击 start.bat 启动。
echo   若启动仍失败，查看 server-err.log。
echo ==========================================================
pause