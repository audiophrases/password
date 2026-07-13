@echo off
setlocal EnableDelayedExpansion
title Password - Setup
cd /d "%~dp0"

echo ==================================================
echo   PASSWORD - guided setup for a new computer
echo ==================================================
echo This wizard checks everything the game needs:
echo   step 1 - Node.js, which runs the local game server.
echo            No admin rights needed - a portable copy works too.
echo   step 2 - optional: a free cloud relay so phones can join
echo            even when the school Wi-Fi blocks them.
echo Nothing is installed system-wide; everything stays in this folder.
echo.

rem ---------- step 1: find or fetch Node ----------
rem Same search order as password.bat: node.exe next to this file, an
rem extracted node-* folder, then an installed Node on PATH.
set "NODE=%~dp0node.exe"
if not exist "!NODE!" (
  for /d %%D in ("%~dp0node-*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"
)
if not exist "!NODE!" set "NODE=node"
"!NODE!" --version >nul 2>nul
if not errorlevel 1 goto node_ok

echo Node.js was not found on this computer. Two ways to get it:
echo.
echo   1 - normal installer from nodejs.org
echo       pick this on a personal computer where you have admin rights
echo   2 - portable copy downloaded into this folder, about 30 MB
echo       pick this on a school or work computer without admin rights
echo.
set "PICK=2"
set /p PICK=Type 1 or 2 and press Enter [2]:
if "!PICK!"=="1" goto node_installer

set "NODE_VER=v22.20.0"
echo.
echo Downloading portable Node !NODE_VER! - about 30 MB...
curl.exe -fL -# -o node-portable.zip "https://nodejs.org/dist/!NODE_VER!/node-!NODE_VER!-win-x64.zip"
if errorlevel 1 goto node_dl_fail
echo Unpacking...
powershell -NoProfile -Command "Expand-Archive -Path 'node-portable.zip' -DestinationPath '.' -Force"
if errorlevel 1 goto node_dl_fail
del node-portable.zip >nul 2>nul
set "NODE=%~dp0node-!NODE_VER!-win-x64\node.exe"
"!NODE!" --version >nul 2>nul
if errorlevel 1 goto node_dl_fail
goto node_ok

:node_installer
echo.
echo Opening nodejs.org - download and run the installer there,
echo then run install.bat again to continue with step 2.
start https://nodejs.org
pause
exit /b 0

:node_dl_fail
echo.
echo The download or unpacking failed - no internet, or the network blocks it.
echo Manual way: on any computer, download
echo     https://nodejs.org/dist/!NODE_VER!/node-!NODE_VER!-win-x64.zip
echo and extract the zip INTO this folder, keeping its folder name.
echo Then run install.bat again.
pause
exit /b 1

:node_ok
for /f "delims=" %%V in ('"!NODE!" --version 2^>nul') do set "NODE_VERSION=%%V"
echo [OK] Node.js !NODE_VERSION! is ready.
echo.
echo The game now works on this computer: double-click password.bat to play.
echo Phones join over the local Wi-Fi IF the network allows device-to-device
echo traffic - home Wi-Fi usually yes, school and office Wi-Fi often no.
echo.

rem ---------- step 2: optional cloud relay ----------
echo --------------------------------------------------
echo   OPTIONAL - cloud relay for the phone remote
echo --------------------------------------------------
echo If phones cannot reach this computer, a free Cloudflare relay lets them
echo join over the internet instead. Several teachers can share one relay -
echo every game gets its own room code - or you can deploy your own.
echo.
echo   d - deploy my own relay, needs a free Cloudflare account, ~5 min
echo   u - use an existing relay URL a colleague gave me
echo   s - skip for now - password.bat works without it
echo.
set "CLOUD=s"
set /p CLOUD=Type d, u or s and press Enter [s]:
if /i "!CLOUD!"=="d" goto cloud_deploy
if /i "!CLOUD!"=="u" goto cloud_url
goto done

:cloud_deploy
rem npx ships next to node.exe, both in the portable zip and in a normal
rem install. Prefer the copy next to our Node - it works even when nothing
rem is on PATH - and fall back to whatever PATH has.
set "NPX=npx"
if /i not "!NODE!"=="node" (
  for %%A in ("!NODE!") do if exist "%%~dpAnpx.cmd" set "NPX=%%~dpAnpx.cmd"
  for %%A in ("!NODE!") do set "PATH=%%~dpA;!PATH!"
)
call "!NPX!" --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo npx was not found next to Node or on PATH, so this computer cannot
  echo deploy the relay itself. That is fine - deploying is a ONE-TIME step
  echo you can do from ANY computer: run install.bat on a home PC and pick d,
  echo then run install.bat here again and pick u to save the relay URL.
  pause
  goto done
)

echo.
echo Step A - a free Cloudflare account, no credit card needed.
echo Opening the signup page - skip it if you already have an account.
start https://dash.cloudflare.com/sign-up
echo When you are signed in, come back here and
pause

echo.
echo Step B - connect this computer to your account.
echo A browser tab opens - click Allow.
call "!NPX!" -y wrangler login
if errorlevel 1 goto cloud_fail

echo.
echo Step C - deploying your relay to Cloudflare's free tier...
call "!NPX!" -y wrangler deploy
if errorlevel 1 goto cloud_fail
echo.
echo In the output above, wrangler printed your relay address - it looks like
echo     https://password-game.YOURNAME.workers.dev

:cloud_url
echo.
set "RELAY_URL="
set /p RELAY_URL=Paste the relay URL here and press Enter:
set "RELAY_URL=!RELAY_URL: =!"
if "!RELAY_URL:~-1!"=="/" set "RELAY_URL=!RELAY_URL:~0,-1!"
echo !RELAY_URL!| findstr /b /c:"https://" >nul
if errorlevel 1 (
  echo That does not look like an https URL - nothing was saved.
  echo Rerun install.bat to retry, or paste the URL into the game's
  echo cloud relay box on the setup screen instead.
  goto done
)
(
  echo // config.js - optional deployment-specific settings.
  echo //
  echo // CLOUD_RELAY: https URL of the deployed cloud relay Worker - see README
  echo // section "Cloud relay". Saved by install.bat; the cloud-relay box on the
  echo // game's setup screen can override it per browser.
  echo export const CLOUD_RELAY = '!RELAY_URL!';
) > js\config.js
echo [OK] Saved to js\config.js - the game's cloud relay box comes prefilled.
goto done

:cloud_fail
echo.
echo The Cloudflare step did not finish. Usual causes: no account yet, the
echo browser window was closed before clicking Allow, or the network blocks
echo the login. Run install.bat again to retry - Node is already set up, so
echo it goes straight to this step.
pause
exit /b 1

:done
echo.
echo ==================================================
echo   Setup finished. To play: double-click password.bat
echo   Phone remote: scan the QR on the setup screen.
echo   Blocked Wi-Fi: tick the cloud relay box first.
echo ==================================================
pause
exit /b 0
