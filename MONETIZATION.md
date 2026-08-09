# Monetization

How Coupon Clipper makes money, what's built, and what to do next — in the order
that earns the most per hour of work.

---

## The uncomfortable part first

**Grocery coupons are close to worthless as affiliate inventory.** Safeway,
Kroger, QFC, and Albertsons — the stores this app is built around — run *no*
public affiliate program. A user can clip a Safeway coupon, drive to the store,
and save $4, and the app earns exactly **$0**. Nothing in the code changes that;
it's how those retailers operate.

So the money does not come from the coupons. It comes from three places:

| Lever | Why it works here | Est. share of revenue |
|---|---|---|
| **Partner referrals (CPA)** | A user clipping coupons is pre-qualified for cashback apps and delivery. One signup pays $3–$30. | ~50% |
| **Pro subscription** | People who track savings will pay a little to track more. Recurring, no traffic tax. | ~30% |
| **Email list** | Costs nothing to re-monetize the same person weekly. Compounds. | ~20%, growing |

Everything below is built around that.

---

## What's built

| Piece | Where | Status |
|---|---|---|
| Server-side click-out tracking | `GET /api/go/:couponId` | ✅ Live |
| Affiliate link wrapping (Impact, Rakuten, CJ, Awin, Amazon) | `affiliate.js` | ✅ Live, needs IDs |
| CPA partner offer wall | `OfferWall.jsx`, `GET /api/offers` | ✅ Live, needs links |
| Conversion postbacks → booked revenue | `POST /api/webhooks/conversion` | ✅ Live |
| Pro subscription + Stripe checkout | `ProUpgrade.jsx`, `/api/pro/*` | ✅ Live, needs Stripe keys |
| Free-tier limits (3 alerts, 15 clips) | `src/lib/pro.js` | ✅ Live |
| Email capture | `EmailCapture.jsx`, `POST /api/subscribe` | ✅ Live |
| Sponsored slots + impression billing | `sponsored` column, `/api/track/impressions` | ✅ Live, no advertisers yet |
| Owner revenue dashboard | `/?admin=1` → Revenue tab | ✅ Live, needs `ADMIN_TOKEN` |

Every affiliate ID is read from the server environment. Nothing is committed,
and nothing reaches the browser bundle. Unset IDs degrade gracefully: the link
still sends the user to the right place, it just earns nothing.

---

## Turn it on — in this order

Each step is roughly ordered by dollars-per-hour-of-effort.

### 1. Set `ADMIN_TOKEN` (2 minutes)

```bash
openssl rand -hex 32     # paste into Railway → Variables → ADMIN_TOKEN
```

Then open `https://your-app.vercel.app/?admin=1` and unlock the Revenue tab.
Without this you're flying blind, and every later decision is a guess.

### 2. Referral links for the CPA partners (1 hour, no approval needed)

These are the highest payout per user and most have **instant** signup — no
affiliate application, no traffic minimum:

| Partner | Typical payout | How to get a link |
|---|---|---|
| Rakuten | ~$25–30 per referral | Rakuten account → "Refer a Friend" |
| Thrive Market | ~$30 CPA | Impact / their affiliate page |
| HelloFresh | ~$15–20 CPA | Impact |
| Instacart | ~$10–15 new customer | Impact |
| Ibotta | ~$5 per referral | Ibotta app → referral code |
| Fetch | ~$3 per referral | Fetch app → referral code |

Paste each into `AFF_IBOTTA_URL`, `AFF_RAKUTEN_REFERRAL_URL`, etc. Payouts are
public rates at time of writing and move around — confirm with each program and
update `AFF_CPA_*` so the dashboard ranks them correctly.

**This step alone is most of the revenue.** It is also the least work.

### 3. Stripe for Pro (30 minutes)

1. Create a recurring product at $3.99/mo → copy the price ID.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `PUBLIC_SITE_URL`.
3. Add a webhook endpoint pointing at `/api/webhooks/stripe`, subscribe to
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, then set `STRIPE_WEBHOOK_SECRET`.

Pro is entitled by email address, since the app has no accounts. That's fine at
this scale and avoids building auth. Revisit if sharing becomes a problem.

### 4. Affiliate networks (1–3 weeks, needs approval)

Apply to **Impact** first — it carries Walmart, Target, Instacart, and most of
the meal-kit and delivery brands, so one approval lights up the most inventory.
Then Rakuten (Costco) and Amazon Associates (Whole Foods).

Amazon requires three qualifying sales within 180 days or the account closes,
so don't apply until there's real traffic.

### 5. Ask each network for postbacks (30 minutes, do it once)

Every click already carries a sub-ID (`cc-<clickId>` / `co-<clickId>`). Point
each network's postback at:

```
POST https://your-api/api/webhooks/conversion
Header: x-webhook-secret: <AFFILIATE_WEBHOOK_SECRET>
Body:   { clickId, network, orderId, orderAmount, commission, status }
```

Until this is wired, the dashboard can only *estimate*. After it's wired, the
"Booked commission" number is real money and the estimate becomes a footnote.

---

## What it's actually worth

Realistic figures for a savings app, per **1,000 monthly active users**:

| Line | Assumption | Monthly |
|---|---|---|
| CPA partner signups | 1.5% take an offer × ~$8 blended | ~$120 |
| Pro subscriptions | 2% convert × $3.99 | ~$80 |
| Email list | 25% capture, ~$0.15/sub/mo | ~$40 |
| Grocery affiliate click-outs | 15% click × 3% CVR × ~$0.05 EPC | ~$8 |
| **Total** | | **~$250** |

That's roughly **$0.25 per active user per month**:

- 1,000 users → ~$250/mo
- 10,000 users → ~$2,500/mo
- 100,000 users → ~$25,000/mo

These are planning numbers, not promises. The conversion rates above are
industry-typical for coupon and cashback audiences; yours will differ, and the
dashboard exists so you replace every one of these guesses with measurements.

**The honest conclusion: revenue here is a traffic problem, not a monetization
problem.** The plumbing is now done and it scales linearly. Nothing in this
document earns anything at zero users.

---

## Highest-leverage thing to build next

**Programmatic SEO.** Coupon search is enormous, recurring, and high commercial
intent — people search "Safeway coupons this week" every single week, forever.

Generate a static page per store × per week (`/safeway-coupons`,
`/kroger-coupons-this-week`, `/target-grocery-deals`), server-rendered from the
catalog already in SQLite. Each page carries the offer wall, the email capture,
and the Pro pitch. This is the only channel here with zero marginal cost per
visitor, and it's what every large coupon site is actually built on.

Second: a **weekly email** to the list built in step 3. It's the cheapest
repeat traffic you will ever get, and it re-monetizes people who already trust
the app.

---

## Two things to fix before scaling

**1. The coupon codes are not real.** `api.js` ships hardcoded codes like
`347334261`, with `generateCouponCode()` and `Math.random()` filling gaps. They
will not scan at a register. That's survivable for a personal tool and fatal
for a monetized product — it's the fastest way to lose an affiliate account and
draw an FTC complaint for deceptive advertising. A `verified` column now exists
on the coupons table; before running paid traffic, either populate it from real
retailer feeds or label unverified coupons plainly in the UI.

**2. Sponsored placements must stay labelled.** The FTC requires paid placement
to be disclosed clearly, not buried. The `Sponsored` badge on `CouponCard` and
the footer disclosure are what keep this compliant — don't remove them to lift
click-through. It's not worth the exposure, and disclosure costs far less
conversion than people assume.
