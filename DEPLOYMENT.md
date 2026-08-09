# Deployment Guide

This application consists of a frontend (React/Vite) deployed on Vercel and a backend (Node.js/Express) deployed on Railway.

## Frontend Deployment (Vercel)

### Current Deployment
- **URL**: https://new-eight-ecru-84.vercel.app
- **Source**: Vite React application
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

### Environment Variables Setup

To connect the Vercel frontend to the Railway backend, you must configure the following environment variable in Vercel:

1. Go to [Vercel Dashboard](https://vercel.com)
2. Select the **"New"** project
3. Click **Settings** → **Environment Variables**
4. Add/Update the following variable:

```
Variable Name: VITE_API_URL
Value: https://web-production-2e894.up.railway.app
Scope: Production (and optionally Preview/Development)
```

5. Click **Save**
6. Trigger a redeploy:
   - Go to the **Deployments** tab
   - Click **Redeploy** on the latest deployment
   - Or push a new commit to trigger automatic deployment

### Verifying the Connection

After deployment, test the connection:
1. Open the Vercel app URL
2. Navigate to "Browse Coupons" tab
3. If coupons load, the API connection is working ✅
4. Check browser console (DevTools) for any API errors

## Backend Deployment (Railway)

### Current Deployment
- **URL**: https://web-production-2e894.up.railway.app
- **Service**: Node.js Express API
- **Start Command**: `node api.js`

### Key Features
- SQLite database for coupon storage
- Scheduled coupon syncing from public sources
- CORS enabled for Vercel frontend
- Auto-restart on failure

### Environment Variables on Railway

The following are automatically configured:
- `PORT`: Assigned by Railway (defaults to 5000)
- `NODE_ENV`: Set as needed
- Database location: SQLite file-based (`coupons.db`)

### Accessing Railway Dashboard
- Go to [Railway Dashboard](https://railway.app)
- Navigate to the "New" project
- View logs and deployments
- Monitor service health

## Local Development

### Start Development Server
```bash
# Install dependencies
npm install

# Start both frontend (dev server) and backend (API)
npm run dev
# Frontend will be at http://localhost:5173
# Backend will be at http://localhost:5000
```

### Environment Variable for Local Development
The application defaults to `http://localhost:5000` if `VITE_API_URL` is not set. Create a `.env` file in the root directory:

```
VITE_API_URL=http://localhost:5000
```

## Troubleshooting

### Frontend shows "Loading" but no coupons appear
- Check browser console for CORS errors
- Verify `VITE_API_URL` environment variable is set in Vercel
- Ensure Railway backend is running and responding
- Test the API directly: `curl https://web-production-2e894.up.railway.app/api/coupons`

### API returns 503 or connection timeout
- Railway backend may be starting up (can take 30 seconds)
- Check Railway dashboard for error logs
- Verify service is running and healthy

### Local development shows "Failed to fetch coupons"
- Ensure `npm run dev` is running the backend API
- Check if port 5000 is available
- Verify Node.js is installed and working

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   Vercel Frontend   │         │  Railway Backend    │
│  React + Vite       │◄───────►│  Node.js Express    │
│  Tailwind CSS       │  HTTPS  │  SQLite Database    │
│                     │         │  Cron Jobs          │
└─────────────────────┘         └─────────────────────┘
         ▲                                 ▲
         │                                 │
    Browser                         External APIs
    (React App)                  (Coupon Sources)
```

## Future Enhancements

- [ ] Database migrations for schema changes
- [ ] Environment-specific configurations
- [ ] Automated backup of SQLite database
- [ ] Monitoring and alerting
- [ ] API rate limiting and security hardening
