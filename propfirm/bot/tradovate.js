/**
 * Minimal Tradovate REST client — exactly the surface the overnight bot needs:
 * authenticate, resolve the front MNQ contract, place a bracketed entry,
 * flatten, and inspect positions/orders. Nothing else.
 *
 * Environments:
 *   demo → https://demo.tradovateapi.com/v1   (paper account, same API)
 *   live → https://live.tradovateapi.com/v1
 *
 * Credentials come from the environment, never from the repo:
 *   TRADOVATE_USER, TRADOVATE_PASS   account login
 *   TRADOVATE_CID,  TRADOVATE_SEC    API key pair (requires the API Access
 *                                    add-on; prop white-labels may not offer
 *                                    it — ask the firm)
 *   TRADOVATE_DEVICE_ID              any stable unique string
 *
 * Access tokens live ~80 minutes. The bot acts twice a night, so it simply
 * authenticates fresh before each action instead of managing renewal.
 */

const HOSTS = {
  demo: 'https://demo.tradovateapi.com/v1',
  live: 'https://live.tradovateapi.com/v1',
}

export class Tradovate {
  constructor({ env = 'demo', fetchImpl = fetch } = {}) {
    if (!HOSTS[env]) throw new Error(`unknown environment ${env}`)
    this.base = HOSTS[env]
    this.env = env
    this.fetch = fetchImpl
    this.token = null
  }

  async #post(path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`${path}: HTTP ${res.status} — ${text.slice(0, 200)}`)
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} — ${JSON.stringify(json).slice(0, 200)}`)
    return json
  }

  async #get(path) {
    const res = await this.fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return res.json()
  }

  async auth() {
    const need = ['TRADOVATE_USER', 'TRADOVATE_PASS', 'TRADOVATE_CID', 'TRADOVATE_SEC', 'TRADOVATE_DEVICE_ID']
    const missing = need.filter((k) => !process.env[k])
    if (missing.length) throw new Error(`missing environment: ${missing.join(', ')}`)
    const out = await this.#post('/auth/accesstokenrequest', {
      name: process.env.TRADOVATE_USER,
      password: process.env.TRADOVATE_PASS,
      appId: 'propfirm-overnight',
      appVersion: '1.0',
      cid: Number(process.env.TRADOVATE_CID),
      sec: process.env.TRADOVATE_SEC,
      deviceId: process.env.TRADOVATE_DEVICE_ID,
    })
    if (out['p-ticket']) throw new Error(`login throttled — retry after ${out['p-time']}s`)
    if (!out.accessToken) throw new Error(`no access token in response: ${JSON.stringify(out).slice(0, 200)}`)
    this.token = out.accessToken
    return out
  }

  /** The account the firm assigned. If several, TRADOVATE_ACCOUNT selects by name. */
  async account() {
    const accounts = await this.#get('/account/list')
    if (!accounts.length) throw new Error('no accounts on this login')
    const wanted = process.env.TRADOVATE_ACCOUNT
    const acct = wanted ? accounts.find((a) => a.name === wanted) : accounts[0]
    if (!acct) throw new Error(`account ${wanted} not found; have: ${accounts.map((a) => a.name).join(', ')}`)
    return acct
  }

  /**
   * Front-month contract for a root like MNQ: /contract/suggest returns
   * tradeable contracts nearest first.
   */
  async frontContract(root) {
    const list = await this.#get(`/contract/suggest?t=${encodeURIComponent(root)}&l=2`)
    const hit = list.find((c) => c.name.startsWith(root))
    if (!hit) throw new Error(`no contract found for ${root}`)
    return hit
  }

  async placeMarket({ account, symbol, qty, action = 'Buy' }) {
    return this.#post('/order/placeorder', {
      accountSpec: account.name,
      accountId: account.id,
      action,
      symbol,
      orderQty: qty,
      orderType: 'Market',
      isAutomated: true,
    })
  }

  async placeStop({ account, symbol, qty, stopPrice, action = 'Sell' }) {
    return this.#post('/order/placeorder', {
      accountSpec: account.name,
      accountId: account.id,
      action,
      symbol,
      orderQty: qty,
      orderType: 'Stop',
      stopPrice,
      isAutomated: true,
    })
  }

  /** Fills for one order id, for reading the actual entry price. */
  async fillsFor(orderId) {
    const fills = await this.#get('/fill/list')
    return fills.filter((f) => f.orderId === orderId)
  }

  async positions() {
    return this.#get('/position/list')
  }

  async workingOrders() {
    const orders = await this.#get('/order/list')
    return orders.filter((o) => ['Working', 'Suspended'].includes(o.ordStatus))
  }

  async cancelOrder(orderId) {
    return this.#post('/order/cancelorder', { orderId, isAutomated: true })
  }

  async liquidate({ account, contractId }) {
    return this.#post('/order/liquidateposition', {
      accountId: account.id,
      contractId,
      admin: false,
    })
  }
}
