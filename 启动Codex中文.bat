@echo off
setlocal
chcp 936 >nul 2>&1
cd /d "%~dp0"

echo [DEBUG] Testing node...
node -v
echo [DEBUG] errorlevel is now: %errorlevel%
node -v >nul 2>&1
echo [DEBUG] after redirect, errorlevel is: %errorlevel%

if errorlevel 1 (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

echo [DEBUG] Node check passed, running script...
node CodexZhLocal.js 9222
echo [DEBUG] node script exit code: %errorlevel%
pause