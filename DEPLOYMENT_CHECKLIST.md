# Deployment Checklist

Complete checklist for deploying the Coupon Clipper application to production.

## ✅ Completed Tasks

### Backend Setup (Railway)
- [x] Node.js Express API configured (`api.js`)
- [x] SQLite database setup with proper schema
- [x] CORS enabled for cross-origin requests
- [x] Coupon syncing from external sources configured
- [x] Health check endpoint available (`/api/health`)
- [x] `railway.json` configured with correct start command
- [x] Automatic restart on failure configured
- [x] Environment set to bind on `0.0.0.0` for container compatibility
- [x] Current deployment: https://web-production-2e894.up.railway.app

### Frontend Setup (Vercel)
- [x] React + Vite application configured
- [x] Tailwind CSS styling setup
- [x] `vercel.json` configured for SPA routing
- [x] Build process verified (npm run build)
- [x] Environment variable placeholder created (VITE_API_URL)
- [x] Current deployment: https://new-eight-ecru-84.vercel.app

### Documentation
- [x] DEPLOYMENT.md - Complete deployment guide
- [x] ENVIRONMENT_SETUP.md - Configuration instructions
- [x] README.md - Updated with current architecture
- [x] .env.example - Default development configuration
- [x] .env.production.example - Production configuration template

### Developer Tools
- [x] setup-dev.sh - Automated setup for macOS/Linux
- [x] setup-dev.bat - Automated setup for Windows
- [x] Local testing verified (backend + frontend)

## 🔴 Manual Tasks Required

### Task 1: Configure Vercel Environment Variables

**⚠️ This is a manual step that requires access to Vercel dashboard**

1. Go to https://vercel.com and log in
2. Select the "New" project
3. Navigate to **Settings** → **Environment Variables**
4. Create/Update the following variable:
   ```
   Name:  VITE_API_URL
   Value: https://web-production-2e894.up.railway.app
   Scope: Production (and optionally Preview/Development)
   ```
5. Click **Save**
6. Go to **Deployments** tab
7. Click **Redeploy** on the latest deployment
8. Wait for redeployment to complete

### Task 2: Verify Connection

After Vercel redeployment:

1. Open https://new-eight-ecru-84.vercel.app in your browser
2. Wait for the page to load completely
3. Navigate to "Browse Coupons" tab
4. Verify that coupons appear and load correctly
5. Check browser console (F12) for any API errors

**Expected Result**: See a list of coupons from various stores (Safeway, Kroger, etc.)

### Task 3: Test All Features

Once coupons are loading:

- [ ] **Browse Tab**: Coupons display with images, titles, discounts
- [ ] **Search**: Search functionality filters coupons correctly
- [ ] **Category Filter**: Filtering by category works
- [ ] **Store Filter**: Filtering by store works
- [ ] **Clip Coupon**: Can clip coupons to collection
- [ ] **My Clipped Tab**: Clipped coupons display with "Mark Used" button
- [ ] **Mark Used**: Can mark coupons as used
- [ ] **Used History**: Used coupons show in history with date and savings
- [ ] **Savings Calculator**: Shows correct totals and counts
- [ ] **QR Codes**: Coupon codes display with scannable QR codes
- [ ] **Price Alerts**: Can create and view price alerts

## 📋 Environment Variables Summary

### For Development (Local)
```
VITE_API_URL=http://localhost:5000
```

### For Production (Vercel)
```
VITE_API_URL=https://web-production-2e894.up.railway.app
```

## 🚀 Current Status

### Frontend
- **Status**: Built and deployed ✅
- **URL**: https://new-eight-ecru-84.vercel.app
- **Build Size**: ~164 KB (JavaScript)
- **Styling**: Tailwind CSS (~14 KB)

### Backend
- **Status**: Running and syncing coupons ✅
- **URL**: https://web-production-2e894.up.railway.app
- **Database**: SQLite with 7+ coupons
- **Endpoints**: `/api/coupons`, `/api/coupons/stores`, `/api/coupons/categories`

### Configuration
- **Status**: Awaiting manual Vercel environment variable setup ⏳
- **Blocker**: Vercel dashboard access required

## ⚠️ Troubleshooting Guide

### Issue: "Loading..." forever on Browse tab

**Cause**: Vercel environment variable not set

**Solution**:
1. Go to Vercel Settings → Environment Variables
2. Ensure `VITE_API_URL` is set to Railway URL
3. Redeploy the application
4. Clear browser cache (Ctrl+Shift+Delete)
5. Refresh the page

### Issue: CORS error in console

**Cause**: Backend CORS not allowing requests

**Solution**:
1. Check backend is running: `curl https://web-production-2e894.up.railway.app/api/health`
2. Restart Railway service if needed
3. Verify `VITE_API_URL` matches exactly in Vercel

### Issue: Database connection error

**Cause**: SQLite database not initialized

**Solution**:
1. Backend automatically creates database on startup
2. Trigger sync: `curl https://web-production-2e894.up.railway.app/api/sync`
3. Check Railway logs for database errors

## 📞 Support Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Railway Documentation](https://docs.railway.app)
- [React Documentation](https://react.dev)
- [Express.js Documentation](https://expressjs.com)

## Next Steps

1. **Immediate**: Set Vercel environment variables (see Task 1 above)
2. **Short-term**: Verify production connection (see Task 2)
3. **Quality Assurance**: Test all features (see Task 3)
4. **Optional**: Set up automated backups for SQLite database
5. **Optional**: Add monitoring and alerting for API health

## Git Branches

- **Main**: Stable production branch
- **claude/grocery-coupon-strategy-irby13**: Development/feature branch with latest changes

Current branch commits:
- Deployment documentation
- Environment configuration
- Setup automation scripts

## Deployment History

| Date | Action | Status |
|------|--------|--------|
| 2026-08-06 | Deploy to Railway (backend) | ✅ Complete |
| 2026-08-06 | Deploy to Vercel (frontend) | ✅ Complete |
| 2026-08-06 | Improve error handling | ✅ Complete |
| 2026-08-09 | Add deployment documentation | ✅ Complete |
| 2026-08-09 | Configure environment setup | ⏳ Pending Vercel env vars |

---

**Last Updated**: 2026-08-09
**Deployed By**: Claude Code
**Status**: Ready for production (awaiting Vercel environment variable configuration)
