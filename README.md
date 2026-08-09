# 💰 Coupon Clipper - Smart Savings System

A personal coupon clipping and tracking web application that helps you organize, manage, and maximize your grocery savings.

## Features

✅ **Browse & Search Coupons**
- Search coupons by name or description
- Filter by category (Dairy, Meat, Pantry, etc.)
- Filter by store (Safeway, Kroger, Walmart, Target, etc.)
- See expiration dates at a glance

✅ **Clip & Manage Coupons**
- One-click coupon clipping
- View all your clipped coupons
- Track which coupons are ready to use
- Unclip coupons you no longer want

✅ **Track Usage & Savings**
- Mark coupons as used after shopping
- View complete history of used coupons
- Calculate actual savings achieved
- See potential savings from clipped coupons

✅ **Price Alerts**
- Set custom price alerts for frequently-bought items
- Monitor specific products at specific stores
- Get notified when deals match your targets

✅ **Savings Dashboard**
- Real-time savings calculator
- Track metrics: actual savings, potential savings, coupons used, coupons clipped
- Visual progress tracking

## Quick Start

### Installation & Setup (Recommended)

```bash
# macOS/Linux
./setup-dev.sh

# Windows
setup-dev.bat
```

Or manually:
```bash
npm install
echo "VITE_API_URL=http://localhost:5000" > .env
```

### Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.
The backend API will run on [http://localhost:5000](http://localhost:5000).

### Build for Production

```bash
VITE_API_URL=https://web-production-2e894.up.railway.app npm run build
npm preview
```

**Note**: You must set `VITE_API_URL` before building. See [ENVIRONMENT_SETUP.md](./ENVIRONMENT_SETUP.md) for details.

## How to Use

### 1. Browse Coupons
- Go to "Browse Coupons" tab
- Use search to find specific items
- Filter by category or store
- Click "Clip Coupon" to save

### 2. Manage Clipped Coupons
- Go to "My Clipped" tab
- See total potential savings
- Click "Mark Used" after shopping
- Or unclip coupons you don't need

### 3. Track Savings
- Check the dashboard for real-time metrics
- Review "Used History" to see what you've saved
- Get insights on your savings habits

### 4. Set Price Alerts
- Go to "Price Alerts" tab
- Click "New Alert"
- Enter product name, target price, and store
- Get reminded when deals match your criteria

## Architecture

This is a full-stack application with separate frontend and backend:

**Frontend** (React/Vite on Vercel)
- Clipped coupons stored locally in browser
- Used coupons history stored locally
- Price alerts stored locally

**Backend** (Node.js/Express on Railway)
- SQLite database for coupon catalog
- Automated coupon sync from external sources
- REST API endpoints for coupon data

## Data Storage

- **Frontend Data**: Clipped coupons, used history, and alerts are stored locally in your browser's localStorage
- **Backend Data**: Master coupon catalog is stored in Railway-hosted SQLite database
- **Privacy**: Your personal data stays in your browser; only coupon data is shared with backend

## Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Lucide React
- **Backend**: Node.js, Express, SQLite
- **Deployment**: Vercel (frontend), Railway (backend)

## Deployment

This application is deployed and ready to use:

- **Frontend**: https://new-eight-ecru-84.vercel.app (Vercel)
- **Backend**: https://web-production-2e894.up.railway.app (Railway)

For deployment instructions and environment setup, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Future Enhancements

- Integration with store loyalty programs (Safeway, Kroger APIs)
- Real coupon data from Ibotta and Fetch Rewards APIs
- Mobile app version
- Sync across devices with cloud backup
- Smart recommendations based on shopping history
- Export shopping lists with coupons
- Coupon barcode integration

## Tips for Maximum Savings

1. **Join store loyalty programs** - Unlock member prices and personalized digital coupons
2. **Stack your savings** - Combine store coupons + manufacturer coupons + cashback apps
3. **Shop sales** - Build meal plans around what's on sale, not fixed items
4. **Stock smart** - Buy staples in bulk when deeply discounted
5. **Use cashback apps** - Ibotta, Fetch Rewards, Shopkick often stack with coupons
6. **Track your prices** - Remember regular prices to identify true deals

## License

MIT