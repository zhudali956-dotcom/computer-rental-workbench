@echo off
cd /d "%~dp0"
if not exist node_modules\esbuild (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run build
if errorlevel 1 goto failed
echo Open http://127.0.0.1:4188 in your browser.
call npm.cmd run demo
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
