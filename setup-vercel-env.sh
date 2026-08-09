#!/bin/bash

# Vercel Environment Variable Setup Script
# This script uses the Vercel CLI to configure environment variables

echo "🔧 Vercel Environment Variable Setup"
echo "===================================="
echo ""

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI is not installed."
    echo ""
    echo "To install Vercel CLI, run:"
    echo "  npm install -g vercel"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo "✅ Vercel CLI found: $(vercel --version)"
echo ""

# Check if user is logged in
echo "🔐 Checking Vercel authentication..."
if ! vercel whoami &> /dev/null; then
    echo "❌ Not logged in to Vercel."
    echo ""
    echo "Please log in first by running:"
    echo "  vercel login"
    echo ""
    exit 1
fi

VERCEL_USER=$(vercel whoami)
echo "✅ Logged in as: $VERCEL_USER"
echo ""

# Get the Railway backend URL
echo "📝 Environment Variable Configuration"
echo ""
echo "Railway Backend URL: https://web-production-2e894.up.railway.app"
echo ""

# Prompt to confirm
read -p "Set VITE_API_URL for production environment? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "🔄 Setting environment variables..."
echo ""

# Set environment variable for production
vercel env add VITE_API_URL

echo ""
echo "✅ Environment variables configured!"
echo ""
echo "Next steps:"
echo "1. Go to https://vercel.com and select the 'New' project"
echo "2. Go to Settings → Deployments"
echo "3. Click 'Redeploy' on the latest deployment"
echo "4. Wait for redeployment to complete"
echo ""
echo "Then verify the connection:"
echo "- Open https://new-eight-ecru-84.vercel.app"
echo "- Go to 'Browse Coupons' tab"
echo "- Confirm coupons load correctly"
