@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

REM ============================================================
REM  Quaestor launcher (dev mode)
REM    backend : Hono  @ http://127.0.0.1:17400  (tsx watch)
REM    web     : Vite  @ http://localhost:5177    (proxies /v1, /health)
REM
REM  Camera capture (receipt shutter) needs a secure context;
REM  http://localhost is treated as secure, so the dev URL works.
REM  Phone access over LAN/tunnel needs HTTPS for the camera.
REM
REM  Optional: set ANTHROPIC_API_KEY to enable receipt OCR.
REM    set ANTHROPIC_API_KEY=sk-ant-...
REM  (without it, OCR falls back to the Claude Code CLI if present)
REM ============================================================

if not exist "node_modules\" (
  echo [Quaestor] installing backend deps...
  call npm install || goto :err
)
if not exist "web\node_modules\" (
  echo [Quaestor] installing web deps...
  call npm --prefix web install || goto :err
)

REM open the browser once the web dev server has had a moment to boot
start "" /b cmd /c "timeout /t 5 >nul & start """" http://localhost:5177"

echo [Quaestor] starting backend + web ... (Ctrl+C to stop)
call npm run dev:all
goto :eof

:err
echo [Quaestor] setup failed.
exit /b 1
