#!/bin/bash

# Coupon Clipper - Development Setup Script

echo "🛠️  Setting up Coupon Clipper development environment..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    exit 1
fi

echo "✅ Node.js $(node --version) found"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "📝 Creating .env file for local development..."
    cat > .env << EOF
VITE_API_URL=http://localhost:5000
EOF
    echo "✅ .env file created with default settings"
else
    echo "✅ .env file already exists"
fi

echo ""
echo "🎉 Setup complete! You can now run:"
echo ""
echo "   npm run dev      - Start development server (frontend + backend)"
echo ""
echo "The application will be available at:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:5000"
echo ""
echo "For production deployment info, see DEPLOYMENT.md"
