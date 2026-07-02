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

echo Stopping any previous Password server/window...
rem Close the previous Password TERMINAL (any other cmd.exe running this .bat,
rem even if it's sitting at 'Server stopped / pause'), then free port 8000.
rem $me = this window's cmd PID (the parent of the spawned powershell), so we
rem never kill ourselves.
powershell -NoProfile -Command "$me=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'password\.bat' -and $_.ProcessId -ne $me } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul

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
