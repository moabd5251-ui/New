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

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm build
npm preview
```

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

## Data Storage

All your data is stored locally in your browser using localStorage:
- Clipped coupons
- Used coupons history
- Price alerts

No data is sent to external servers - your savings tracking stays private.

## Tech Stack

- **Frontend**: React 18
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **Icons**: Lucide React
- **Storage**: Browser localStorage

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