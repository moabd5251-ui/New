@echo off
REM Vercel Environment Variable Setup Script
REM This script uses the Vercel CLI to configure environment variables

echo.
echo 🔧 Vercel Environment Variable Setup
echo ====================================
echo.

REM Check if Vercel CLI is installed
where vercel >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Vercel CLI is not installed.
    echo.
    echo To install Vercel CLI, run:
    echo   npm install -g vercel
    echo.
    echo Then run this script again.
    pause
    exit /b 1
)

echo ✅ Vercel CLI found
for /f "tokens=*" %%i in ('vercel --version') do echo    %%i
echo.

REM Check if user is logged in
echo 🔐 Checking Vercel authentication...
vercel whoami >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Not logged in to Vercel.
    echo.
    echo Please log in first by running:
    echo   vercel login
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('vercel whoami') do echo ✅ Logged in as: %%i
echo.

REM Get the Railway backend URL
echo 📝 Environment Variable Configuration
echo.
echo Railway Backend URL: https://web-production-2e894.up.railway.app
echo.

REM Prompt to confirm
set /p confirm="Set VITE_API_URL for production environment? (y/n) "
if /i not "%confirm%"=="y" (
    echo Cancelled.
    exit /b 0
)

echo.
echo 🔄 Setting environment variables...
echo.

REM Set environment variable for production
vercel env add VITE_API_URL

echo.
echo ✅ Environment variables configured!
echo.
echo Next steps:
echo 1. Go to https://vercel.com and select the 'New' project
echo 2. Go to Settings → Deployments
echo 3. Click 'Redeploy' on the latest deployment
echo 4. Wait for redeployment to complete
echo.
echo Then verify the connection:
echo - Open https://new-eight-ecru-84.vercel.app
echo - Go to 'Browse Coupons' tab
echo - Confirm coupons load correctly
echo.
pause
