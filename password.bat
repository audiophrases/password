@echo off
title Password
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

echo Stopping any previous Password server...
rem Kill whatever is already listening on port 8000 (a leftover server) so this
rem run starts clean instead of failing with "address in use".
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul

echo ============================================
echo   PASSWORD - starting local server
echo ============================================
echo   Game ^(this laptop^):  http://localhost:8000
echo   Phone remote:        printed below as http://YOUR-IP:8000/remote
echo.
echo   Open the phone URL on a phone that is on the
echo   SAME Wi-Fi (or join this laptop to the phone's hotspot).
echo   Keep this window open while you play. Close it to stop.
echo ============================================
echo.

start "" http://localhost:8000
node server.js

echo.
echo Server stopped.
pause
