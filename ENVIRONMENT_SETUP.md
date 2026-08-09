# Environment Configuration Guide

## Overview

This application requires environment variables to connect the frontend to the backend API. Different configuration methods are available depending on your deployment platform.

## Local Development

### Option 1: Using the Setup Script (Recommended)

**On macOS/Linux:**
```bash
./setup-dev.sh
npm run dev
```

**On Windows:**
```bash
setup-dev.bat
npm run dev
```

The setup script will automatically create a `.env` file with the correct configuration for local development.

### Option 2: Manual Setup

1. Create a `.env` file in the project root:
```bash
echo "VITE_API_URL=http://localhost:5000" > .env
```

2. Start the development server:
```bash
npm run dev
```

The frontend will automatically use `http://localhost:5000` as the API endpoint.

## Production Deployment - Vercel

### Step-by-Step Setup

1. **Log in to Vercel Dashboard**
   - Go to https://vercel.com
   - Sign in with your GitHub account

2. **Navigate to Project Settings**
   - Select the "New" project
   - Click **Settings** in the top menu

3. **Add Environment Variables**
   - Click **Environment Variables** in the left sidebar
   - Click **Add New**
   - Fill in the following:
     - **Name**: `VITE_API_URL`
     - **Value**: `https://web-production-2e894.up.railway.app`
     - **Environments**: Select Production (and optionally Preview/Development)
   - Click **Save**

4. **Redeploy the Application**
   - Go to the **Deployments** tab
   - Find the latest deployment
   - Click the **...** menu and select **Redeploy**
   - Or push a new commit to trigger automatic redeployment

### Verification

After redeployment, verify the connection works:

1. Open https://new-eight-ecru-84.vercel.app
2. Wait for the page to load
3. Check the "Browse Coupons" tab
4. If coupons appear, the connection is working ✅

**If coupons don't appear:**
- Open browser DevTools (F12)
- Check the Console tab for errors
- Look for API-related error messages
- Verify the `VITE_API_URL` environment variable is correctly set in Vercel

## Production Deployment - Other Platforms

### Using Environment File

Create a `.env.production` file:
```
VITE_API_URL=https://your-api-url.com
```

Then build:
```bash
npm run build
```

### Using Build-time Variables

Pass the variable during build:
```bash
VITE_API_URL=https://your-api-url.com npm run build
```

### Docker Deployment

If deploying with Docker, pass the environment variable:
```bash
docker build -t coupon-clipper .
docker run -e VITE_API_URL=https://your-api-url.com coupon-clipper
```

## Available Endpoints

The application uses the following API endpoints (replace with your actual API URL):

- `GET /api/coupons` - Get all available coupons
- `GET /api/coupons/stores` - Get list of stores
- `GET /api/coupons/categories` - Get list of categories
- `POST /api/sync` - Trigger coupon sync (admin only)
- `GET /api/health` - Health check

## Troubleshooting

### "Failed to fetch coupons" error

**Cause**: Frontend can't reach the API

**Solution**:
1. Verify `VITE_API_URL` is correctly set
2. Test the API directly: `curl https://your-api-url.com/api/coupons`
3. Check browser console for CORS errors
4. Ensure Railway backend is running

### CORS errors in browser

**Cause**: Backend doesn't allow requests from your frontend domain

**Solution**:
1. Verify backend has CORS enabled (should be by default)
2. Check backend logs for CORS errors
3. Restart the backend service

### Environment variable not recognized

**For Vercel**:
- Ensure variable is added to **all required environments** (Production, Preview, Development)
- Redeploy after adding/changing variables
- Wait 30 seconds for cache to clear

**For local development**:
- Restart `npm run dev` after editing `.env`
- Ensure `.env` file is in the project root
- Don't commit `.env` to git (it's in `.gitignore`)

## Supported API URLs

### Development
- `http://localhost:5000` - Local backend

### Production (Railway)
- `https://web-production-2e894.up.railway.app` - Current Railway deployment

### Custom Deployments
- `https://your-custom-domain.com` - Your own server
- `https://api.example.com` - Any publicly accessible API

## Best Practices

1. **Never commit `.env` files to git** - Use `.env.example` or `.env.production.example` instead
2. **Use environment-specific variables** - Different URLs for dev/staging/production
3. **Keep API URL secure** - Don't expose internal IPs or sensitive paths
4. **Test connection after deployment** - Always verify the app can reach the API
5. **Use HTTPS in production** - Ensure secure connections to your API

## Additional Resources

- [Vercel Environment Variables Documentation](https://vercel.com/docs/projects/environment-variables)
- [Vite Environment Variables Documentation](https://vitejs.dev/guide/env-and-modes.html)
- [Railway Documentation](https://docs.railway.app)
