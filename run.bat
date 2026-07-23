@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title AkboPlay

echo.
echo  ========================================
echo   AkboPlay - local test
echo  ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install LTS from https://nodejs.org
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [INSTALL] app dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)

if not exist "server\node_modules\" (
  echo [INSTALL] server dependencies...
  call npm --prefix server install
  if errorlevel 1 (
    echo [ERROR] server npm install failed
    pause
    exit /b 1
  )
)

if not exist "server\.env" (
  if exist "server\.env.example" (
    echo [SETUP] copying server\.env.example to server\.env
    copy /Y "server\.env.example" "server\.env" >nul
  )
)

set "EXPO_PUBLIC_API_URL=http://localhost:4000"

echo [1/2] Starting API server  -^> http://localhost:4000
start "AkboPlay-API" cmd /k npm run server

ping -n 3 127.0.0.1 >nul

echo [2/2] Starting Expo web   -^> http://localhost:8081
echo.
echo   Close each window or press Ctrl+C to stop.
echo.

start "AkboPlay-Web" cmd /k "set EXPO_PUBLIC_API_URL=http://localhost:4000&& npx expo start --web"

ping -n 8 127.0.0.1 >nul
start "" http://localhost:8081

echo.
echo Started:
echo   - AkboPlay-API  window (API)
echo   - AkboPlay-Web  window (Expo)
echo   - Browser: http://localhost:8081
echo.
echo You can close this window.
pause
endlocal
