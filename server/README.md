# Coupon Clipper Backend API

Node.js/Express backend for fetching and managing real coupons from Seattle-area stores.

## Setup

### 1. Install Dependencies

```bash
cd server
npm install
```

### 2. Start the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

Server will run on `http://localhost:5000`

## Features

✅ **Daily Coupon Sync** - Automatically fetches coupons at 2 AM daily
✅ **Seattle Area Coverage** - Safeway, Fred Meyer, QFC, Costco, Walmart, Target
✅ **SQLite Database** - Local caching of coupons
✅ **REST API** - Easy integration with frontend
✅ **Filtering** - By store, category, search term

## API Endpoints

### Get All Coupons
```
GET /api/coupons
Query params:
  - store: "Safeway" | "Walmart" | etc
  - category: "Dairy" | "Meat" | etc
  - search: "milk" | etc
```

**Example:**
```
GET /api/coupons?store=Safeway&search=milk
```

### Get All Stores
```
GET /api/coupons/stores
```

### Get All Categories
```
GET /api/coupons/categories
```

### Manual Sync
```
POST /api/sync
```

### Health Check
```
GET /api/health
```

## Database

Uses SQLite3 with the following schema:

**coupons table:**
- id (INTEGER PRIMARY KEY)
- title (TEXT)
- store (TEXT)
- discount (REAL)
- category (TEXT)
- expiresAt (DATETIME)
- description (TEXT)
- image (TEXT)
- source (TEXT)
- createdAt (DATETIME)

**sync_log table:**
- id (INTEGER PRIMARY KEY)
- source (TEXT)
- lastSync (DATETIME)
- count (INTEGER)
- status (TEXT)

## Configuration

### Environment Variables

Create a `.env` file:
```
PORT=5000
```

### Daily Sync Schedule

Currently set to 2 AM daily (cron: `0 2 * * *`)

To change, edit the cron schedule in `server.js`:
```javascript
cron.schedule('0 2 * * *', () => {
  syncCoupons()
})
```

## Adding New Coupon Sources

Add new fetcher functions to `couponSources` object in `server.js`:

```javascript
const couponSources = {
  async fetchMyStore() {
    return [
      {
        title: "Save $X on Product",
        store: "Store Name",
        discount: 2.50,
        category: "Category",
        expiresAt: new Date(...).toISOString(),
        description: "Details",
        image: "🏷️",
        source: "Store Weekly Ad"
      }
    ]
  }
}
```

## Integration with Frontend

The frontend fetches coupons from `http://localhost:5000/api/coupons`

Set `VITE_API_URL` environment variable in frontend `.env.local`:
```
VITE_API_URL=http://localhost:5000
```

## Deployment

To deploy the backend:

1. **Heroku:**
   ```bash
   git push heroku main
   ```

2. **Vercel:**
   - Add serverless function configuration

3. **Railway:**
   - Connect repository and deploy

## Troubleshooting

### Port already in use
```bash
lsof -i :5000
kill -9 <PID>
```

### Database locked
Delete `coupons.db` and restart:
```bash
rm coupons.db
npm run dev
```

### Coupons not updating
Manually trigger sync:
```bash
curl -X POST http://localhost:5000/api/sync
```

## Future Enhancements

- [ ] Integrate with real APIs (Ibotta, Fetch Rewards)
- [ ] Multi-city support
- [ ] User accounts and preferences
- [ ] Push notifications for deal alerts
- [ ] OCR for receipt-based coupons
- [ ] Machine learning for personalized recommendations

## License

MIT
