@echo off
REM Coupon Clipper - Development Setup Script for Windows

echo.
echo 🛠️  Setting up Coupon Clipper development environment...
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js is not installed. Please install Node.js 16+ first.
    echo    Download from: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js %NODE_VERSION% found

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install

if %ERRORLEVEL% EQU 0 (
    echo ✅ Dependencies installed
) else (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

REM Create .env file if it doesn't exist
if not exist ".env" (
    echo 📝 Creating .env file for local development...
    (
        echo VITE_API_URL=http://localhost:5000
    ) > .env
    echo ✅ .env file created with default settings
) else (
    echo ✅ .env file already exists
)

echo.
echo 🎉 Setup complete! You can now run:
echo.
echo    npm run dev      - Start development server (frontend + backend)
echo.
echo The application will be available at:
echo    Frontend: http://localhost:5173
echo    Backend:  http://localhost:5000
echo.
echo For production deployment info, see DEPLOYMENT.md
echo.
pause
