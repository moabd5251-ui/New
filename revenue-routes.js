/**
 * Revenue layer: click-out tracking, affiliate attribution, sponsored slots,
 * email capture, and the Pro subscription.
 *
 * Kept separate from api.js so the coupon catalog and the money plumbing can
 * be reasoned about (and broken) independently.
 */

import crypto from 'crypto'
import axios from 'axios'
import {
  cpaOffers,
  configuredNetworks,
  estimateClickValue,
  resolveDestination,
  buildTrackedUrl,
  ASSUMED_CVR,
} from './affiliate.js'

const PRO_PRICE_USD = parseFloat(process.env.PRO_PRICE_USD || '3.99')

/** Add a column only if it isn't already there, so redeploys are idempotent. */
function ensureColumn(db, table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) return console.error(`Schema check failed for ${table}:`, err.message)
    if (rows.some(r => r.name === column)) return
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, e => {
      if (e) console.error(`Could not add ${table}.${column}:`, e.message)
      else console.log(`🧱 Added column ${table}.${column}`)
    })
  })
}

function initRevenueSchema(db) {
  db.serialize(() => {
    // Monetization fields on the existing catalog.
    ensureColumn(db, 'coupons', 'affiliateUrl', 'TEXT')
    ensureColumn(db, 'coupons', 'network', 'TEXT')
    ensureColumn(db, 'coupons', 'sponsored', 'INTEGER DEFAULT 0')
    ensureColumn(db, 'coupons', 'cpcRate', 'REAL DEFAULT 0')
    ensureColumn(db, 'coupons', 'verified', 'INTEGER DEFAULT 0')

    db.run(`
      CREATE TABLE IF NOT EXISTS clicks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        couponId INTEGER,
        offerKey TEXT,
        store TEXT,
        network TEXT,
        kind TEXT,
        sessionId TEXT,
        estValue REAL DEFAULT 0,
        referrer TEXT,
        userAgent TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_clicks_createdAt ON clicks(createdAt)')

    db.run(`
      CREATE TABLE IF NOT EXISTS conversions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clickId INTEGER,
        network TEXT,
        orderId TEXT,
        orderAmount REAL DEFAULT 0,
        commission REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(network, orderId)
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS impressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        couponId INTEGER,
        day TEXT,
        count INTEGER DEFAULT 0,
        UNIQUE(couponId, day)
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        source TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS pro_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'inactive',
        stripeCustomerId TEXT,
        stripeSubscriptionId TEXT,
        currentPeriodEnd DATETIME,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  })
}

/** Admin endpoints are locked behind a shared token you set in the env. */
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) {
    return res.status(503).json({
      error: 'Revenue dashboard is locked until ADMIN_TOKEN is set on the server.',
      hint: 'Set ADMIN_TOKEN to a long random string in your Railway variables, then reload.',
    })
  }
  const provided = req.get('x-admin-token') || req.query.token || ''
  const a = Buffer.from(String(provided))
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin token' })
  }
  next()
}

const isEmail = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())

export function registerRevenueRoutes(app, db) {
  initRevenueSchema(db)

  // ---------------------------------------------------------------------
  // Click-out: the single funnel every outbound link goes through.
  // Logging happens server-side so ad blockers can't erase our attribution,
  // and affiliate IDs never reach the browser.
  // ---------------------------------------------------------------------
  app.get('/api/go/:couponId', (req, res) => {
    const sessionId = String(req.query.s || 'anon').slice(0, 64)

    db.get('SELECT * FROM coupons WHERE id = ?', [req.params.couponId], (err, coupon) => {
      if (err || !coupon) return res.status(404).json({ error: 'Coupon not found' })

      const destination = resolveDestination(coupon)
      if (!destination) {
        return res.status(404).json({ error: 'No online destination for this coupon' })
      }

      const estValue = estimateClickValue(destination)
      db.run(
        `INSERT INTO clicks (couponId, store, network, kind, sessionId, estValue, referrer, userAgent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          coupon.id,
          coupon.store,
          destination.network,
          destination.kind,
          sessionId,
          estValue,
          req.get('referer') || '',
          (req.get('user-agent') || '').slice(0, 255),
        ],
        function (insertErr) {
          const clickId = insertErr ? `nc-${Date.now()}` : `cc-${this.lastID}`
          res.redirect(302, buildTrackedUrl(destination, clickId))
        }
      )
    })
  })

  // Same funnel for the flat-fee partner offers, which aren't catalog rows.
  app.get('/api/go/offer/:key', (req, res) => {
    const offer = cpaOffers.find(o => o.key === req.params.key)
    if (!offer) return res.status(404).json({ error: 'Unknown offer' })

    const sessionId = String(req.query.s || 'anon').slice(0, 64)
    const destination = { kind: 'cpa', network: offer.network, url: offer.url, payout: offer.payout }
    const estValue = estimateClickValue(destination)

    db.run(
      `INSERT INTO clicks (offerKey, store, network, kind, sessionId, estValue, referrer, userAgent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        offer.key,
        offer.name,
        offer.network,
        'cpa',
        sessionId,
        estValue,
        req.get('referer') || '',
        (req.get('user-agent') || '').slice(0, 255),
      ],
      function (insertErr) {
        const clickId = insertErr ? `no-${Date.now()}` : `co-${this.lastID}`
        res.redirect(302, buildTrackedUrl(destination, clickId))
      }
    )
  })

  // Public offer wall. Payout amounts are deliberately omitted — users don't
  // need to see what we earn, and competitors shouldn't.
  app.get('/api/offers', (_req, res) => {
    res.json(
      cpaOffers.map(({ key, name, blurb, category, icon }) => ({ key, name, blurb, category, icon }))
    )
  })

  // Sponsored impressions, batched by the client once per render.
  app.post('/api/track/impressions', (req, res) => {
    const ids = Array.isArray(req.body?.couponIds) ? req.body.couponIds.slice(0, 100) : []
    const day = new Date().toISOString().slice(0, 10)

    for (const rawId of ids) {
      const couponId = parseInt(rawId, 10)
      if (!Number.isInteger(couponId)) continue
      db.run(
        `INSERT INTO impressions (couponId, day, count) VALUES (?, ?, 1)
         ON CONFLICT(couponId, day) DO UPDATE SET count = count + 1`,
        [couponId, day]
      )
    }
    res.json({ recorded: ids.length })
  })

  // ---------------------------------------------------------------------
  // Conversion postbacks. Networks call this when a click turns into a sale.
  // ---------------------------------------------------------------------
  app.post('/api/webhooks/conversion', (req, res) => {
    const secret = process.env.AFFILIATE_WEBHOOK_SECRET
    if (!secret) return res.status(503).json({ error: 'AFFILIATE_WEBHOOK_SECRET not configured' })

    const provided = Buffer.from(String(req.get('x-webhook-secret') || ''))
    const expected = Buffer.from(secret)
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Bad signature' })
    }

    const { clickId, network, orderId, orderAmount, commission, status } = req.body || {}
    if (!orderId || !network) return res.status(400).json({ error: 'network and orderId required' })

    // clickId comes back in the network's sub-id field as "cc-<id>" or "co-<id>".
    const numericClickId = parseInt(String(clickId || '').replace(/^c[co]-/, ''), 10) || null

    db.run(
      `INSERT INTO conversions (clickId, network, orderId, orderAmount, commission, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(network, orderId) DO UPDATE SET
         orderAmount = excluded.orderAmount,
         commission  = excluded.commission,
         status      = excluded.status`,
      [
        numericClickId,
        network,
        String(orderId),
        parseFloat(orderAmount) || 0,
        parseFloat(commission) || 0,
        status || 'pending',
      ],
      err => {
        if (err) return res.status(500).json({ error: err.message })
        res.json({ ok: true })
      }
    )
  })

  // ---------------------------------------------------------------------
  // Email list — the highest-LTV asset here. Every send is a chance to
  // re-monetize the same person at zero acquisition cost.
  // ---------------------------------------------------------------------
  app.post('/api/subscribe', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' })

    db.run(
      'INSERT OR IGNORE INTO subscribers (email, source) VALUES (?, ?)',
      [email, String(req.body?.source || 'app').slice(0, 40)],
      err => {
        if (err) return res.status(500).json({ error: err.message })
        res.json({ ok: true })
      }
    )
  })

  // ---------------------------------------------------------------------
  // Pro subscription.
  // ---------------------------------------------------------------------
  app.get('/api/pro/status', (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase()
    if (!isEmail(email)) return res.json({ active: false })

    db.get('SELECT status, currentPeriodEnd FROM pro_subscriptions WHERE email = ?', [email], (err, row) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ active: row?.status === 'active', currentPeriodEnd: row?.currentPeriodEnd || null })
    })
  })

  app.post('/api/pro/checkout', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' })

    const key = process.env.STRIPE_SECRET_KEY
    const price = process.env.STRIPE_PRICE_ID
    if (!key || !price) {
      return res.status(503).json({
        error: 'Checkout is not live yet.',
        hint: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID on the server to enable Pro billing.',
      })
    }

    const site = process.env.PUBLIC_SITE_URL || req.get('origin') || ''
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      customer_email: email,
      success_url: `${site}/?pro=success`,
      cancel_url: `${site}/?pro=cancelled`,
      'metadata[email]': email,
    })

    try {
      const { data } = await axios.post('https://api.stripe.com/v1/checkout/sessions', form, {
        auth: { username: key, password: '' },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      })
      db.run('INSERT OR IGNORE INTO pro_subscriptions (email, status) VALUES (?, ?)', [email, 'pending'])
      res.json({ url: data.url })
    } catch (err) {
      console.error('Stripe checkout failed:', err.response?.data || err.message)
      res.status(502).json({ error: 'Could not start checkout. Try again.' })
    }
  })

  // Stripe signs the raw request bytes, which api.js stashes on req.rawBody.
  app.post('/api/webhooks/stripe', (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) return res.status(503).send('STRIPE_WEBHOOK_SECRET not configured')

    const header = req.get('stripe-signature') || ''
    const timestamp = /t=(\d+)/.exec(header)?.[1]
    const signature = /v1=([a-f0-9]+)/.exec(header)?.[1]
    if (!timestamp || !signature) return res.status(400).send('Bad signature header')

    if (!Buffer.isBuffer(req.rawBody)) return res.status(400).send('Raw body unavailable')
    const payload = req.rawBody.toString('utf8')
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex')

    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).send('Signature mismatch')
    }

    let event
    try {
      event = JSON.parse(payload)
    } catch {
      return res.status(400).send('Unparseable payload')
    }

    const object = event.data?.object || {}
    const email = (object.metadata?.email || object.customer_email || object.customer_details?.email || '')
      .toLowerCase()

    const activate = ['checkout.session.completed', 'customer.subscription.updated'].includes(event.type)
    const cancel = event.type === 'customer.subscription.deleted'

    if (email && (activate || cancel)) {
      const status = cancel ? 'cancelled' : object.status === 'past_due' ? 'past_due' : 'active'
      db.run(
        `INSERT INTO pro_subscriptions (email, status, stripeCustomerId, stripeSubscriptionId, updatedAt)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(email) DO UPDATE SET
           status = excluded.status,
           stripeCustomerId = COALESCE(excluded.stripeCustomerId, pro_subscriptions.stripeCustomerId),
           stripeSubscriptionId = COALESCE(excluded.stripeSubscriptionId, pro_subscriptions.stripeSubscriptionId),
           updatedAt = CURRENT_TIMESTAMP`,
        [email, status, object.customer || null, object.subscription || object.id || null]
      )
    }

    res.json({ received: true })
  })

  // ---------------------------------------------------------------------
  // Owner-only revenue dashboard.
  // ---------------------------------------------------------------------
  app.get('/api/revenue', requireAdmin, (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
    const since = `-${days} days`

    const queries = {
      totals: [
        `SELECT COUNT(*) AS clicks, COALESCE(SUM(estValue), 0) AS estRevenue
         FROM clicks WHERE createdAt >= datetime('now', ?)`,
        [since],
      ],
      booked: [
        `SELECT COUNT(*) AS conversions,
                COALESCE(SUM(commission), 0) AS commission,
                COALESCE(SUM(CASE WHEN status = 'approved' THEN commission ELSE 0 END), 0) AS approved
         FROM conversions WHERE createdAt >= datetime('now', ?)`,
        [since],
      ],
      byStore: [
        `SELECT COALESCE(store, 'Unknown') AS store, kind, COUNT(*) AS clicks,
                COALESCE(SUM(estValue), 0) AS estRevenue
         FROM clicks WHERE createdAt >= datetime('now', ?)
         GROUP BY store, kind ORDER BY estRevenue DESC LIMIT 25`,
        [since],
      ],
      daily: [
        `SELECT date(createdAt) AS day, COUNT(*) AS clicks,
                COALESCE(SUM(estValue), 0) AS estRevenue
         FROM clicks WHERE createdAt >= datetime('now', ?)
         GROUP BY day ORDER BY day`,
        [since],
      ],
      topCoupons: [
        `SELECT c.couponId, COALESCE(k.title, 'Removed coupon') AS title,
                COUNT(*) AS clicks, COALESCE(SUM(c.estValue), 0) AS estRevenue
         FROM clicks c LEFT JOIN coupons k ON k.id = c.couponId
         WHERE c.couponId IS NOT NULL AND c.createdAt >= datetime('now', ?)
         GROUP BY c.couponId ORDER BY estRevenue DESC LIMIT 10`,
        [since],
      ],
      audience: [
        `SELECT
           (SELECT COUNT(*) FROM subscribers) AS subscribers,
           (SELECT COUNT(*) FROM pro_subscriptions WHERE status = 'active') AS proMembers`,
        [],
      ],
    }

    const results = {}
    const keys = Object.keys(queries)
    let remaining = keys.length
    let failed = false

    for (const key of keys) {
      const [sql, params] = queries[key]
      db.all(sql, params, (err, rows) => {
        if (failed) return
        if (err) {
          failed = true
          return res.status(500).json({ error: err.message })
        }
        results[key] = rows
        if (--remaining === 0) {
          const totals = results.totals[0] || { clicks: 0, estRevenue: 0 }
          const booked = results.booked[0] || { conversions: 0, commission: 0, approved: 0 }
          const audience = results.audience[0] || { subscribers: 0, proMembers: 0 }

          res.json({
            windowDays: days,
            clicks: totals.clicks,
            estRevenue: totals.estRevenue,
            estEpc: totals.clicks ? totals.estRevenue / totals.clicks : 0,
            bookedConversions: booked.conversions,
            bookedCommission: booked.commission,
            approvedCommission: booked.approved,
            assumedCvr: ASSUMED_CVR,
            mrr: audience.proMembers * PRO_PRICE_USD,
            proPrice: PRO_PRICE_USD,
            subscribers: audience.subscribers,
            proMembers: audience.proMembers,
            byStore: results.byStore,
            daily: results.daily,
            topCoupons: results.topCoupons,
            networks: configuredNetworks(),
          })
        }
      })
    }
  })

  console.log('💸 Revenue routes registered')
}
