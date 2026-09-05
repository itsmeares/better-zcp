@echo off
title Zomboid Control Panel (Source)
echo ============================================
echo   ZOMBOID CONTROL PANEL - Run from Source
echo ============================================
echo.
echo Checking for Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please download it from: https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo Node.js found: 
node --version
echo.
echo Installing dependencies...
call corepack enable
call corepack install
call pnpm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo.
echo Building client...
call pnpm build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to build client
    pause
    exit /b 1
)
echo.
echo ============================================
echo Starting server...
echo (the panel will print the URL to open once it is ready)
echo ============================================
echo.
pnpm start
pause
