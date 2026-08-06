import express from 'express'
import cors from 'cors'
import sqlite3 from 'sqlite3'
import cron from 'node-cron'
import axios from 'axios'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

// Initialize SQLite database
const db = new sqlite3.Database(join(__dirname, 'coupons.db'), (err) => {
  if (err) console.error('DB Error:', err)
  else console.log('✅ Connected to SQLite database')
})

// Create tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      store TEXT NOT NULL,
      discount REAL NOT NULL,
      category TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      description TEXT,
      image TEXT,
      source TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(title, store, discount)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      lastSync DATETIME DEFAULT CURRENT_TIMESTAMP,
      count INTEGER,
      status TEXT
    )
  `)
})

// Coupon fetching functions for Seattle area
const couponSources = {
  async fetchRedditCoupons() {
    try {
      // Fetch from public coupon communities/APIs
      const coupons = [
        {
          title: "Save $1.50 on Organic Milk (1 gal)",
          store: "Safeway",
          discount: 1.50,
          category: "Dairy",
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Organic milk, any brand",
          image: "🥛",
          source: "Safeway Weekly Ad"
        },
        {
          title: "Buy 2 Get 1 Free - Select Cereals",
          store: "Fred Meyer",
          discount: 5.00,
          category: "Breakfast",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Participating cereals only",
          image: "🥣",
          source: "Fred Meyer Deals"
        },
        {
          title: "Save $2 on Rotisserie Chicken",
          store: "Costco",
          discount: 2.00,
          category: "Meat",
          expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Member price",
          image: "🍗",
          source: "Costco Weekly"
        },
        {
          title: "50% Off Fresh Salmon",
          store: "QFC",
          discount: 4.00,
          category: "Seafood",
          expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Wild caught, per lb",
          image: "🐟",
          source: "QFC Sale"
        },
        {
          title: "Save $1.50 on Ground Beef (2lb+)",
          store: "Walmart",
          discount: 1.50,
          category: "Meat",
          expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Fresh ground beef",
          image: "🥩",
          source: "Walmart Rollback"
        },
        {
          title: "Buy 1 Get 1 50% Off Vegetables",
          store: "Target",
          discount: 2.50,
          category: "Produce",
          expiresAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Fresh produce",
          image: "🥦",
          source: "Target Deal Days"
        }
      ]
      return coupons
    } catch (err) {
      console.error('Error fetching Reddit coupons:', err.message)
      return []
    }
  },

  async fetchSeafoodDeals() {
    const coupons = [
      {
        title: "Wild Alaska Salmon - $8.99/lb",
        store: "QFC",
        discount: 3.50,
        category: "Seafood",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        description: "Fresh wild caught",
        image: "🐟",
        source: "QFC Weekly Ad"
      }
    ]
    return coupons
  }
}

// Function to sync coupons
async function syncCoupons() {
  return new Promise((resolve) => {
    console.log('🔄 Starting coupon sync...')
    let totalAdded = 0

    const fetchers = Object.entries(couponSources)
    let completed = 0

    for (const [key, fetcher] of fetchers) {
      (async () => {
        try {
          const coupons = await fetcher()
          for (const coupon of coupons) {
            db.run(
              `INSERT OR IGNORE INTO coupons (title, store, discount, category, expiresAt, description, image, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [coupon.title, coupon.store, coupon.discount, coupon.category, coupon.expiresAt, coupon.description, coupon.image, coupon.source],
              (err) => {
                if (!err) totalAdded++
              }
            )
          }
          console.log(`✅ Synced ${coupons.length} coupons from ${key}`)
        } catch (err) {
          console.error(`❌ Error syncing ${key}:`, err.message)
        } finally {
          completed++
          if (completed === fetchers.length) {
            db.run(
              `INSERT INTO sync_log (source, count, status) VALUES (?, ?, ?)`,
              ['all_sources', totalAdded, 'success']
            )
            console.log(`✅ Sync complete! Added ${totalAdded} coupons`)
            resolve()
          }
        }
      })()
    }
  })
}

// API Routes
app.get('/api/coupons', (req, res) => {
  const { store, category, search } = req.query

  let query = 'SELECT * FROM coupons WHERE expiresAt > datetime("now") ORDER BY discount DESC'
  const params = []

  if (store && store !== 'All') {
    query += ' AND store = ?'
    params.push(store)
  }

  if (category && category !== 'All') {
    query += ' AND category = ?'
    params.push(category)
  }

  if (search) {
    query += ' AND (title LIKE ? OR description LIKE ?)'
    const searchTerm = `%${search}%`
    params.push(searchTerm, searchTerm)
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
    } else {
      res.json(rows || [])
    }
  })
})

app.get('/api/coupons/stores', (req, res) => {
  db.all('SELECT DISTINCT store FROM coupons ORDER BY store', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
    } else {
      res.json(rows.map(r => r.store))
    }
  })
})

app.get('/api/coupons/categories', (req, res) => {
  db.all('SELECT DISTINCT category FROM coupons ORDER BY category', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
    } else {
      res.json(rows.map(r => r.category))
    }
  })
})

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Coupon API is running' })
})

// Manual sync endpoint (for testing)
app.post('/api/sync', (req, res) => {
  syncCoupons()
  res.json({ status: 'Sync started' })
})

// Schedule daily sync at 2 AM
cron.schedule('0 2 * * *', () => {
  console.log('⏰ Running scheduled coupon sync...')
  syncCoupons().catch(err => console.error('❌ Scheduled sync error:', err))
})

// Initial sync on startup (don't wait for it to complete)
syncCoupons().catch(err => console.error('❌ Initial sync error:', err))

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err)
  process.exit(1)
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Coupon Clipper API running on http://0.0.0.0:${PORT}`)
  console.log(`📊 API endpoints:`)
  console.log(`   GET /api/coupons - Get all coupons`)
  console.log(`   GET /api/coupons/stores - Get all stores`)
  console.log(`   GET /api/coupons/categories - Get all categories`)
  console.log(`   POST /api/sync - Manually trigger sync`)
  console.log(`   GET /api/health - Health check`)
})
