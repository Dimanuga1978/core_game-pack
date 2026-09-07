@echo off
setlocal enabledelayedexpansion
REM One-click start for Windows: double-click this file (or run
REM `start.cmd` from any directory) and it starts the game server AND
REM the launcher, each in its own window, with a fresh random secret
REM generated automatically -- nothing to type, nothing to copy-paste,
REM no PowerShell/cmd env-var syntax to get right.
REM
REM Always operates on the folder THIS FILE lives in, regardless of
REM where it was invoked from (double-click, a shortcut on the desktop,
REM a different starting directory in a terminal) -- %~dp0 is the
REM directory containing this script, with a trailing backslash.
cd /d "%~dp0"

if not exist node_modules (
  echo First run: installing dependencies, this can take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed -- see the error above. Common causes on Windows:
    echo   - Node.js not installed, or not added to PATH
    echo   - Antivirus blocking npm from creating files
    echo.
    pause
    exit /b 1
  )
)

REM A fresh secret every run is fine and deliberate: nothing about a
REM running match survives a server restart anyway (matches live only in
REM memory -- see ADMIN.md), so there is no reason to persist one across
REM runs, and generating it here means the person running this script
REM never sees or has to handle it directly.
for /f "delims=" %%s in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set TABLECORE_SERVER_SECRET=%%s

if not defined TABLECORE_SERVER_CONFIG set TABLECORE_SERVER_CONFIG=tools\server\example.config.mjs

REM Bind to all interfaces, not just loopback -- 127.0.0.1 is ONLY
REM reachable from this exact machine. Real people testing this on their
REM own laptops/phones over the same Wi-Fi/LAN need the server and
REM launcher reachable from THEIR machine, which means binding to 0.0.0.0
REM here. The admin API is deliberately kept on loopback-only (see
REM ADMIN.md's own security section: it can create matches and mint valid
REM tokens, and isn't something every tester's machine needs to reach --
REM only whoever is running this script, from this same machine, needs
REM it).
if not defined TABLECORE_SERVER_HOST set TABLECORE_SERVER_HOST=0.0.0.0
if not defined TABLECORE_LAUNCHER_HOST set TABLECORE_LAUNCHER_HOST=0.0.0.0
if not defined TABLECORE_SERVER_ADMIN_HOST set TABLECORE_SERVER_ADMIN_HOST=127.0.0.1

REM Best-effort LAN IP for the summary below -- reuses the exact same
REM detection logic tools\server\start.mjs's own startup banner uses
REM (tools\lan-ip.mjs), so this script and the server it starts can never
REM disagree about which address is "the" LAN IP.
set LAN_IP=
for /f "delims=" %%i in ('node tools\lan-ip.mjs 2^>nul') do set LAN_IP=%%i

echo Starting the game server (window: "TableCore Server")...
start "TableCore Server" cmd /k "set TABLECORE_SERVER_SECRET=%TABLECORE_SERVER_SECRET%&& set TABLECORE_SERVER_CONFIG=%TABLECORE_SERVER_CONFIG%&& set TABLECORE_SERVER_HOST=%TABLECORE_SERVER_HOST%&& set TABLECORE_SERVER_ADMIN_HOST=%TABLECORE_SERVER_ADMIN_HOST%&& npm run server"

timeout /t 2 /nobreak >nul

echo Starting the launcher (window: "TableCore Launcher")...
start "TableCore Launcher" cmd /k "set TABLECORE_LAUNCHER_HOST=%TABLECORE_LAUNCHER_HOST%&& npm run launcher"

timeout /t 2 /nobreak >nul

echo Opening the launcher in your browser...
start "" "http://127.0.0.1:4170"

echo.
echo ================================================================
echo  Server and launcher are running in their own windows.
echo  On this machine:                   http://127.0.0.1:4170
if defined LAN_IP (
  echo  For other people on this network:  http://%LAN_IP%:4170
) else (
  echo  Could not detect a LAN IP for sharing with other machines --
  echo  if others can't connect, check your network connection/firewall.
)
echo  Admin API (this machine only, by design):  http://127.0.0.1:4181
echo.
echo  To stop everything, close the two new windows that opened
echo  ("TableCore Server" and "TableCore Launcher").
echo ================================================================
echo.
pause
