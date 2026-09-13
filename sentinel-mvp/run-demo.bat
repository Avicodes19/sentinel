@echo off
cd /d %~dp0
where node >nul 2>nul
if %errorlevel%==0 (
  echo Starting SENTINEL with Node...
  node server\index.js
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  echo Node not found. Starting static demo with Python...
  python -m http.server 3000 -d public
  goto :eof
)
echo Please install Node.js 20+ or Python 3.
pause
