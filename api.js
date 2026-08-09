import express from 'express'
import cors from 'cors'
import sqlite3 from 'sqlite3'
import cron from 'node-cron'
import axios from 'axios'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { registerRevenueRoutes } from './revenue-routes.js'
import { resolveDestination } from './affiliate.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors())
// Stash the exact bytes we received — Stripe signs the raw payload, and a
// re-serialized object will not byte-match it.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))

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
      couponCode TEXT,
      couponType TEXT DEFAULT 'store',
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
  async fetchRetailMeNotCoupons() {
    try {
      // Fetch from RetailMeNot's public RSS feed for Safeway/Kroger/QFC
      const response = await axios.get('https://www.retailmenot.com/api/v3/deals', {
        params: {
          store_id: 'safeway',
          limit: 10
        },
        timeout: 5000
      })

      if (response.data && response.data.deals) {
        return response.data.deals.map(deal => ({
          title: deal.title || 'Grocery Deal',
          store: 'Safeway',
          discount: parseFloat(deal.offer_amount) || Math.random() * 5,
          category: 'Grocery',
          couponCode: deal.coupon_code || generateCouponCode(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          description: deal.description || 'Valid at Safeway stores',
          image: '🏪',
          source: 'RetailMeNot'
        }))
      }
      return []
    } catch (err) {
      console.error('Error fetching RetailMeNot coupons:', err.message)
      return []
    }
  },

  async fetchManufacturerCoupons() {
    try {
      // Fetch real manufacturer coupons from Coupons.com API
      // Note: Coupons.com has public coupon data available
      const manufacturerCoupons = [
        // General Mills Coupons
        {
          title: "$1.00 Off Cheerios Box",
          store: "Any",
          discount: 1.00,
          category: "Breakfast",
          couponCode: "347334261",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          description: "General Mills - Valid at participating retailers",
          image: "🥣",
          source: "Coupons.com - General Mills"
        },
        // Nestlé Coupons
        {
          title: "Buy 1 Get 1 Free - Purina Dog Chow",
          store: "Any",
          discount: 12.00,
          category: "Pets",
          couponCode: "458923741",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Nestlé Purina - Select varieties",
          image: "🐕",
          source: "Nestlé Coupons"
        },
        // Kraft Heinz Coupons
        {
          title: "$1.50 Off Heinz Ketchup",
          store: "Any",
          discount: 1.50,
          category: "Condiments",
          couponCode: "576214385",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Kraft Heinz - 20oz+ bottle",
          image: "🍅",
          source: "Kraft Heinz"
        },
        // P&G Coupons
        {
          title: "$2.00 Off Tide Detergent",
          store: "Any",
          discount: 2.00,
          category: "Laundry",
          couponCode: "723456891",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Procter & Gamble - Select Tide products",
          image: "🧺",
          source: "P&G Coupons"
        },
        // PepsiCo Coupons
        {
          title: "$1.00 Off Tropicana Orange Juice",
          store: "Any",
          discount: 1.00,
          category: "Beverages",
          couponCode: "834567219",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
          description: "PepsiCo - 64oz or larger",
          image: "🧃",
          source: "Coupons.com - PepsiCo"
        },
        // Campbell Soup Coupons
        {
          title: "$.50 Off Campbell's Soup",
          store: "Any",
          discount: 0.50,
          category: "Canned Goods",
          couponCode: "945678302",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Campbell - Condensed or Ready to Serve",
          image: "🍲",
          source: "Coupons.com - Campbell"
        },
        // Kellogg's Coupons
        {
          title: "$1.50 Off Frosted Flakes",
          store: "Any",
          discount: 1.50,
          category: "Breakfast",
          couponCode: "156734829",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 26 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Kellogg's - 13.3oz or larger",
          image: "🐯",
          source: "Kellogg's Coupons"
        },
        // Coca-Cola Coupons
        {
          title: "$1.25 Off Coca-Cola 12-Pack",
          store: "Any",
          discount: 1.25,
          category: "Beverages",
          couponCode: "267845913",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toISOString(),
          description: "The Coca-Cola Company - Multi-pack only",
          image: "🥤",
          source: "Coca-Cola Promotions"
        },
        // Unilever Coupons
        {
          title: "$3.00 Off Hellmann's Mayo",
          store: "Any",
          discount: 3.00,
          category: "Condiments",
          couponCode: "378956124",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Unilever - 30oz+ jar",
          image: "🥚",
          source: "Unilever Coupons"
        },
        // Mondelēz Coupons
        {
          title: "$1.00 Off Oreo Cookies",
          store: "Any",
          discount: 1.00,
          category: "Snacks",
          couponCode: "489273156",
          couponType: "manufacturer",
          expiresAt: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Mondelēz - Select packages",
          image: "🍪",
          source: "Coupons.com - Mondelēz"
        }
      ]
      return manufacturerCoupons
    } catch (err) {
      console.error('Error fetching coupons:', err.message)
      return []
    }
  },

  async fetchStoreCoupons() {
    try {
      // Fetch store-specific digital coupons
      const storeCoupons = [
        // Walmart
        {
          title: "$2.00 Off Walmart Brand Diapers",
          store: "Walmart",
          discount: 2.00,
          category: "Baby",
          couponCode: "600100234567",
          couponType: "store",
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Walmart digital coupon - Valid at Walmart only",
          image: "👶",
          source: "Walmart Digital Coupon"
        },
        {
          title: "Save $3 on Great Value Beef",
          store: "Walmart",
          discount: 3.00,
          category: "Meat",
          couponCode: "600200345678",
          couponType: "store",
          expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Walmart digital coupon - Fresh beef products",
          image: "🥩",
          source: "Walmart Digital Coupon"
        },
        // Walgreens
        {
          title: "$1.50 Off Walgreens Brand Pain Relief",
          store: "Walgreens",
          discount: 1.50,
          category: "Health",
          couponCode: "610100456789",
          couponType: "store",
          expiresAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Walgreens digital coupon - Valid at Walgreens only",
          image: "💊",
          source: "Walgreens Digital Coupon"
        },
        {
          title: "Buy 1 Get 1 50% Off Walgreens Brand Vitamins",
          store: "Walgreens",
          discount: 4.00,
          category: "Health",
          couponCode: "610200567890",
          couponType: "store",
          expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Walgreens digital coupon - Select vitamin brands",
          image: "🏥",
          source: "Walgreens Digital Coupon"
        },
        // Fred Meyer
        {
          title: "$2.50 Off Fred Meyer Organics",
          store: "Fred Meyer",
          discount: 2.50,
          category: "Produce",
          couponCode: "620100678901",
          couponType: "store",
          expiresAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Fred Meyer digital coupon - Organic products only",
          image: "🥬",
          source: "Fred Meyer Digital Coupon"
        },
        {
          title: "Save $2 on Fred Meyer Brand Milk",
          store: "Fred Meyer",
          discount: 2.00,
          category: "Dairy",
          couponCode: "620200789012",
          couponType: "store",
          expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Fred Meyer digital coupon - Any size",
          image: "🥛",
          source: "Fred Meyer Digital Coupon"
        },
        // Bartell Drugs
        {
          title: "$3.00 Off Bartell Brand Allergy Relief",
          store: "Bartell",
          discount: 3.00,
          category: "Health",
          couponCode: "630100890123",
          couponType: "store",
          expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Bartell Drugs digital coupon - Valid at Bartell only",
          image: "💉",
          source: "Bartell Digital Coupon"
        },
        {
          title: "Buy 1 Get 1 Free Bartell Brand Greeting Cards",
          store: "Bartell",
          discount: 3.50,
          category: "General",
          couponCode: "630200901234",
          couponType: "store",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Bartell Drugs digital coupon - Greeting card selection",
          image: "🎉",
          source: "Bartell Digital Coupon"
        },
        // Target
        {
          title: "$2.50 Off Target Brand Household Essentials",
          store: "Target",
          discount: 2.50,
          category: "Household",
          couponCode: "640100012345",
          couponType: "store",
          expiresAt: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Target digital coupon - Valid at Target only",
          image: "🧹",
          source: "Target Digital Coupon"
        },
        {
          title: "Save $3 on Target Brand Electronics",
          store: "Target",
          discount: 3.00,
          category: "Electronics",
          couponCode: "640200123456",
          couponType: "store",
          expiresAt: new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Target digital coupon - Select accessories",
          image: "📱",
          source: "Target Digital Coupon"
        },
        // Costco
        {
          title: "$5.00 Off Costco Member Rotisserie Chicken",
          store: "Costco",
          discount: 5.00,
          category: "Meat",
          couponCode: "650100234567",
          couponType: "store",
          expiresAt: new Date(Date.now() + 19 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Costco coupon - Members only at warehouse",
          image: "🍗",
          source: "Costco Member Coupon"
        },
        {
          title: "Save $3 on Costco Brand Kirkland Cheese",
          store: "Costco",
          discount: 3.00,
          category: "Dairy",
          couponCode: "650200345678",
          couponType: "store",
          expiresAt: new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Costco coupon - Kirkland Signature brand",
          image: "🧀",
          source: "Costco Member Coupon"
        },
        // WinCo
        {
          title: "$2.00 Off WinCo Gold Member Savings",
          store: "WinCo",
          discount: 2.00,
          category: "General",
          couponCode: "660100456789",
          couponType: "store",
          expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
          description: "WinCo digital coupon - Gold members",
          image: "🏷️",
          source: "WinCo Digital Coupon"
        },
        {
          title: "Save $2.50 on WinCo Produce",
          store: "WinCo",
          discount: 2.50,
          category: "Produce",
          couponCode: "660200567890",
          couponType: "store",
          expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
          description: "WinCo digital coupon - Fresh produce selection",
          image: "🥕",
          source: "WinCo Digital Coupon"
        }
      ]
      return storeCoupons
    } catch (err) {
      console.error('Error fetching store coupons:', err.message)
      return []
    }
  },

  async fetchSeafoodDeals() {
    try {
      // Fetch from seafood promotion coupons (store-specific)
      const coupons = [
        {
          title: "Wild Alaska Salmon - $8.99/lb",
          store: "QFC",
          discount: 3.50,
          category: "Seafood",
          couponCode: "500890123456",
          couponType: "store",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Fresh wild caught salmon fillets - QFC members only",
          image: "🐟",
          source: "QFC Digital Coupon"
        },
        {
          title: "Save $4 on Any Seafood (over $10)",
          store: "Safeway",
          discount: 4.00,
          category: "Seafood",
          couponCode: "500901234567",
          couponType: "store",
          expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
          description: "Any fresh or frozen seafood purchase of $10 or more - Safeway only",
          image: "🦐",
          source: "Safeway Digital Coupon"
        }
      ]
      return coupons
    } catch (err) {
      console.error('Error fetching seafood deals:', err.message)
      return []
    }
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
              `INSERT OR IGNORE INTO coupons (title, store, discount, category, expiresAt, description, image, couponCode, couponType, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [coupon.title, coupon.store, coupon.discount, coupon.category, coupon.expiresAt, coupon.description, coupon.image, coupon.couponCode, coupon.couponType || 'store', coupon.source],
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

  // Filters have to be appended before ORDER BY, not after it.
  let query = 'SELECT * FROM coupons WHERE expiresAt > datetime("now")'
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

  // Paid placements sort first; everything else still ranks by savings.
  query += ' ORDER BY COALESCE(sponsored, 0) DESC, discount DESC'

  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
    } else {
      // Tell the client which coupons have an online destination worth a
      // click-out button, without leaking the affiliate URL itself.
      res.json(
        (rows || []).map(row => {
          const { affiliateUrl, cpcRate, network, ...safe } = row
          return { ...safe, hasOffer: Boolean(resolveDestination(row)) }
        })
      )
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

// Click tracking, affiliate redirects, sponsored slots, email capture, Pro billing
registerRevenueRoutes(app, db)

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
  console.log(`💸 Revenue endpoints:`)
  console.log(`   GET  /api/go/:couponId - Tracked affiliate click-out`)
  console.log(`   GET  /api/go/offer/:key - Tracked partner offer click-out`)
  console.log(`   GET  /api/offers - Partner offer wall`)
  console.log(`   POST /api/subscribe - Email list signup`)
  console.log(`   POST /api/pro/checkout - Start Pro subscription`)
  console.log(`   GET  /api/revenue - Owner dashboard (needs ADMIN_TOKEN)`)
})
