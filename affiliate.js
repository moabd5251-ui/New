/**
 * Affiliate / partner revenue configuration.
 *
 * Every ID here is read from the environment so that no tracking credential
 * is ever committed to the repo. Until an ID is set, the corresponding
 * partner is "unconfigured": links still work, they just fall through to the
 * plain merchant URL and earn nothing. That means the app is shippable today
 * and starts earning the moment you paste an ID into Railway's env vars.
 *
 * See MONETIZATION.md for which programs to apply to and in what order.
 */

const env = (key, fallback = '') => process.env[key] || fallback
const num = (key, fallback) => {
  const raw = process.env[key]
  const parsed = raw === undefined ? NaN : parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Affiliate networks we can route a click through.
 *
 * `build(url, id, subId)` returns a tracked URL. `subId` is our own click ID —
 * every major network echoes it back on conversion postbacks, which is how we
 * attribute a sale to the exact coupon that earned it.
 */
export const networks = {
  impact: {
    label: 'Impact',
    id: env('AFF_IMPACT_ID'),
    build: (url, id, subId) =>
      `https://${id}.pxf.io/c/${id}?u=${encodeURIComponent(url)}&subId1=${encodeURIComponent(subId)}`,
  },
  rakuten: {
    label: 'Rakuten Advertising',
    id: env('AFF_RAKUTEN_ID'),
    build: (url, id, subId) =>
      `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(id)}&murl=${encodeURIComponent(url)}&u1=${encodeURIComponent(subId)}`,
  },
  cj: {
    label: 'CJ Affiliate',
    id: env('AFF_CJ_ID'),
    build: (url, id, subId) =>
      `https://www.anrdoezrs.net/links/${encodeURIComponent(id)}/type/dlg/sid/${encodeURIComponent(subId)}/${encodeURIComponent(url)}`,
  },
  awin: {
    label: 'Awin',
    id: env('AFF_AWIN_ID'),
    build: (url, id, subId) =>
      `https://www.awin1.com/cread.php?awinmid=${encodeURIComponent(id)}&clickref=${encodeURIComponent(subId)}&ued=${encodeURIComponent(url)}`,
  },
  amazon: {
    label: 'Amazon Associates',
    id: env('AFF_AMAZON_TAG'),
    build: (url, id, subId) => {
      const u = new URL(url)
      u.searchParams.set('tag', id)
      u.searchParams.set('ascsubtag', subId)
      return u.toString()
    },
  },
  // Generic passthrough for partners that hand you a ready-made link and just
  // want a sub-id appended (most CPA referral programs work this way).
  direct: {
    label: 'Direct partner link',
    id: 'direct',
    build: (url, _id, subId) => {
      const u = new URL(url)
      u.searchParams.set('subid', subId)
      return u.toString()
    },
  },
}

/**
 * Per-store routing for grocery coupons.
 *
 * Reality check, and this drives the whole strategy: the big grocery chains
 * (Safeway, Kroger, QFC, Albertsons) run *no* public affiliate program. A
 * clipped Safeway coupon earns $0 no matter how well it converts. The stores
 * listed here with a network are the ones that actually pay.
 */
export const storeRouting = {
  Walmart: { network: 'impact', url: 'https://www.walmart.com/grocery', rate: 0.02 },
  Target: { network: 'impact', url: 'https://www.target.com/c/grocery', rate: 0.02 },
  Amazon: { network: 'amazon', url: 'https://www.amazon.com/alm/storefront', rate: 0.03 },
  'Whole Foods': { network: 'amazon', url: 'https://www.amazon.com/fmc/storefront', rate: 0.03 },
  Costco: { network: 'rakuten', url: 'https://www.costco.com/grocery.html', rate: 0.01 },
  Instacart: { network: 'impact', url: 'https://www.instacart.com', rate: 0 },
  // No affiliate program — tracked for analytics, monetized via Pro + sponsors.
  Safeway: { network: null, url: 'https://www.safeway.com/foru/coupons-deals.html', rate: 0 },
  Kroger: { network: null, url: 'https://www.kroger.com/cl/coupons/', rate: 0 },
  QFC: { network: null, url: 'https://www.qfc.com/cl/coupons/', rate: 0 },
  Albertsons: { network: null, url: 'https://www.albertsons.com/foru/coupons-deals.html', rate: 0 },
}

/**
 * Flat-fee (CPA) partner offers.
 *
 * These are the real money for a coupon audience: a grocery affiliate click is
 * worth pennies, but a cashback-app or meal-kit signup from someone who is
 * *already* clipping coupons pays $5-$30 once. Payouts below are the
 * documented public rates at time of writing; treat them as estimates and
 * override with AFF_CPA_<KEY> once your dashboards show real numbers.
 */
export const cpaOffers = [
  {
    key: 'ibotta',
    name: 'Ibotta',
    blurb: 'Cash back on the groceries you already buy. Stacks on top of every coupon here.',
    category: 'Cashback',
    icon: '💵',
    url: env('AFF_IBOTTA_URL', 'https://ibotta.com'),
    network: 'direct',
    payout: num('AFF_CPA_IBOTTA', 5),
  },
  {
    key: 'rakuten',
    name: 'Rakuten',
    blurb: 'Up to 10% back at 3,500+ stores, plus a welcome bonus after your first purchase.',
    category: 'Cashback',
    icon: '🛍️',
    url: env('AFF_RAKUTEN_REFERRAL_URL', 'https://www.rakuten.com'),
    network: 'direct',
    payout: num('AFF_CPA_RAKUTEN', 25),
  },
  {
    key: 'fetch',
    name: 'Fetch Rewards',
    blurb: 'Snap any grocery receipt, earn points. Works with the coupons you just clipped.',
    category: 'Cashback',
    icon: '🧾',
    url: env('AFF_FETCH_URL', 'https://fetch.com'),
    network: 'direct',
    payout: num('AFF_CPA_FETCH', 3),
  },
  {
    key: 'instacart',
    name: 'Instacart',
    blurb: 'Same groceries, delivered. New customers get free delivery on the first order.',
    category: 'Delivery',
    icon: '🥕',
    url: env('AFF_INSTACART_URL', 'https://www.instacart.com'),
    network: 'impact',
    payout: num('AFF_CPA_INSTACART', 12),
  },
  {
    key: 'hellofresh',
    name: 'HelloFresh',
    blurb: 'Meal kits that beat per-serving grocery cost on the first several boxes.',
    category: 'Meal kits',
    icon: '🍳',
    url: env('AFF_HELLOFRESH_URL', 'https://www.hellofresh.com'),
    network: 'impact',
    payout: num('AFF_CPA_HELLOFRESH', 18),
  },
  {
    key: 'thrive',
    name: 'Thrive Market',
    blurb: 'Membership warehouse pricing on pantry staples, shipped.',
    category: 'Grocery',
    icon: '🌱',
    url: env('AFF_THRIVE_URL', 'https://thrivemarket.com'),
    network: 'impact',
    payout: num('AFF_CPA_THRIVE', 30),
  },
]

/** Average basket size used to turn a % commission rate into an expected $/click. */
export const ASSUMED_BASKET = num('REV_ASSUMED_BASKET', 85)

/** Share of click-outs that end in a purchase. Tune from your own data. */
export const ASSUMED_CVR = num('REV_ASSUMED_CVR', 0.03)

/**
 * Expected value of a single click, in dollars.
 *
 * This is an *estimate* shown in the revenue dashboard so you can rank offers
 * before any real commission data exists. Once affiliate postbacks start
 * landing in the `conversions` table, the dashboard reports booked revenue
 * alongside it and you should trust the booked number.
 */
export function estimateClickValue({ kind, rate = 0, payout = 0 }) {
  if (kind === 'cpa') return payout * ASSUMED_CVR
  if (kind === 'sponsored') return rate
  return ASSUMED_BASKET * rate * ASSUMED_CVR
}

/**
 * Resolve a coupon to its outbound destination.
 *
 * Order of preference:
 *   1. An explicit affiliate URL stored on the coupon row (sponsored deals).
 *   2. The store's routing entry.
 *   3. Null — no destination, so the UI hides the click-out button entirely
 *      rather than shipping a dead link.
 */
export function resolveDestination(coupon) {
  if (coupon.affiliateUrl) {
    return {
      kind: coupon.sponsored ? 'sponsored' : 'affiliate',
      network: coupon.network || 'direct',
      url: coupon.affiliateUrl,
      rate: coupon.cpcRate || 0,
    }
  }

  const route = storeRouting[coupon.store]
  if (!route) return null

  return { kind: 'affiliate', network: route.network, url: route.url, rate: route.rate }
}

/**
 * Wrap a destination URL in its network's tracking redirect.
 *
 * Returns the untouched URL when the network is unknown or its ID has not been
 * configured yet, so an unconfigured deploy still sends users somewhere useful.
 */
export function buildTrackedUrl(destination, clickId) {
  const net = destination.network && networks[destination.network]
  if (!net || !net.id) return destination.url

  try {
    return net.build(destination.url, net.id, clickId)
  } catch (err) {
    console.error('Affiliate link build failed:', err.message)
    return destination.url
  }
}

/** Which partners are actually earning right now — surfaced on the dashboard. */
export function configuredNetworks() {
  return Object.entries(networks)
    .filter(([key]) => key !== 'direct')
    .map(([key, net]) => ({ key, label: net.label, configured: Boolean(net.id) }))
}
