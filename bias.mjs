#!/usr/bin/env node
/**
 * Pre-session Playbook B bias report. Run around 06:45 ET.
 *
 * Says long / short / NO TRADE for today, using the SAME dailyBias() the
 * journal uses — not a reimplementation, which could disagree with the record.
 *
 * Fetches its own fresh bars into a scratch store. It never writes to the
 * registered journals, so running it twenty times costs nothing but time.
 */
import { CandleStore } from '/home/valuedcustomer/nq-collect/propfirm/src/data/store.js'
import { dailyBias, TRENDCONT_SPEC as S } from '/home/valuedcustomer/nq-collect/propfirm/src/research/trendcont.js'
import { atr } from '/home/valuedcustomer/nq-collect/propfirm/src/core/candles.js'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Is the thing that gathers this data actually working?
 *
 * The bias below is computed from whatever is in the store, and it looks
 * exactly as confident when the store is stale as when it is current. On
 * 2026-08-25 the nightly unit failed on DNS, sat in `failed` state, and nothing
 * said so. A report that reads the data should report the health of the
 * collector that produced it.
 */
function collectionHealth() {
  let failed = false
  try {
    execSync('systemctl --user is-failed --quiet nq-collect.service', { stdio: 'ignore' })
    failed = true            // is-failed exits 0 when the unit IS failed
  } catch { failed = false }
  const marker = '/home/valuedcustomer/nq-collect/.collect-failed'
  const detail = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
  return { failed, detail }
}

const STORE = process.env.BIAS_STORE ?? '/home/valuedcustomer/nq-collect/propfirm/data'
const et = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
const etDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

const c = new CandleStore(STORE, 'NQ=F').load()
if (!c.length) { console.log('  no candles in the store — run collect.sh first'); process.exit(1) }

const now = Date.now()
const last = c.at(-1)
const ageH = (now - last.t) / 3.6e6
const b = dailyBias(c, now, S)
const a = atr(c, 14).at(-1)

console.log(`\n  PLAYBOOK B — PRE-SESSION BIAS   ${etDate(new Date())}  (${et(new Date())} ET)`)
console.log('  ' + '─'.repeat(64))
const health = collectionHealth()
if (health.failed || health.detail) {
  console.log('  ** COLLECTOR FAILED — the store may be missing sessions **')
  for (const line of (health.detail ?? 'nq-collect.service is in failed state').split('\n')) {
    console.log(`     ${line}`)
  }
  console.log('     Yahoo serves a moving 7-day window; past that the bars are gone.')
  console.log('     Clear with: systemctl --user reset-failed nq-collect.service')
  console.log('')
}
console.log(`  store      ${c.length.toLocaleString()} bars, last ${etDate(new Date(last.t))} ${et(new Date(last.t))} ET `
  + `(${ageH.toFixed(1)}h old)${ageH > 20 ? '   ** STALE — run collect.sh **' : ''}`)
console.log(`  last price ${last.c.toFixed(2)}    ATR14(1m) ${a?.toFixed(2) ?? '—'}`)
console.log('')
if (b.dir === null) {
  console.log(`  >>> NO TRADE TODAY`)
  console.log(`      ${b.why}`)
} else {
  console.log(`  >>> BIAS: ${b.dir > 0 ? 'LONG ONLY' : 'SHORT ONLY'}`)
  console.log(`      ${b.why}`)
  console.log('')
  console.log(`      window        ${hhmm(S.killzoneStart)}–${hhmm(S.killzoneEnd)} ET, max ${S.maxPerDay} trades, flat ${hhmm(S.flatBy)}`)
  console.log(`      pullback      must be >= ${S.minPullbackAtr} x ATR = ${(a * S.minPullbackAtr).toFixed(1)} pts from the prior swing`)
  console.log(`      entry         LIMIT at the FVG edge the trigger leg leaves. Do NOT enter at market —`)
  console.log(`                    entering at market instead of waiting scores -0.089R / +0.098R.`)
  console.log(`      cancel if     price takes out the pullback extreme first, or ${S.entryWindow} bars pass`)
  console.log(`      stop          pullback extreme ${b.dir > 0 ? '-' : '+'} ${S.stopTicks} ticks (${(S.stopTicks * S.tickSize).toFixed(2)} pts)`)
  console.log(`      target        half off at ${S.firstTargetR}R, stop to breakeven, trail the rest on the prior 15m ${b.dir > 0 ? 'low' : 'high'}`)
  console.log('')
  console.log(`      only ${b.dir > 0 ? 'LONGS' : 'SHORTS'} count today. A setup the other way is not a Playbook B trade.`)
}
console.log(`\n  Paper//research tool. SPEC v${S.version} (registered ${S.registered}) — killzone ${hhmm(S.killzoneStart)}-${hhmm(S.killzoneEnd)} ET.`)
console.log(`  NOTHING IS MEASURED ON THIS WINDOW. The +0.101R / t=2.64 / n=2433 figure was`)
console.log(`  measured on the v1 07:00-10:00 ET killzone and does not carry over; the`)
console.log(`  confirmatory sample restarted at n=0 on ${S.registered} per pre-registration §7.\n`)
