import { useState, useEffect, useCallback } from 'react'
import { API_URL } from './api'

/** What the free tier gets. Everything past this is the upgrade pitch. */
export const FREE_LIMITS = {
  alerts: 3,
  clippedCoupons: 15,
}

export const PRO_PRICE = '$3.99/mo'

export const PRO_FEATURES = [
  'Unlimited price alerts (free plan stops at 3)',
  'Unlimited clipped coupons',
  'Stacking suggestions — store + manufacturer + cashback on one item',
  'Weekly best-deals email before coupons expire',
  'Expiry reminders so nothing goes to waste',
  'No sponsored placements in your feed',
]

/**
 * Entitlement is keyed on the email used at checkout. There are no accounts in
 * this app, so the email is the identity — cached locally and re-verified
 * against the server on load so a cancelled subscription actually lapses.
 */
export function useProStatus() {
  const [email, setEmail] = useState(() => localStorage.getItem('proEmail') || '')
  const [active, setActive] = useState(() => localStorage.getItem('proActive') === 'true')
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async (candidate = email) => {
    if (!candidate) {
      setActive(false)
      localStorage.setItem('proActive', 'false')
      return false
    }
    setChecking(true)
    try {
      const res = await fetch(`${API_URL}/api/pro/status?email=${encodeURIComponent(candidate)}`)
      const data = await res.json()
      setActive(Boolean(data.active))
      localStorage.setItem('proActive', String(Boolean(data.active)))
      return Boolean(data.active)
    } catch {
      // Offline or API down: keep the cached answer rather than locking a
      // paying member out of features they bought.
      return active
    } finally {
      setChecking(false)
    }
  }, [email, active])

  useEffect(() => {
    refresh()
    // Intentionally runs once on mount; refresh() is called explicitly elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const linkEmail = useCallback(async (value) => {
    const next = value.trim().toLowerCase()
    setEmail(next)
    localStorage.setItem('proEmail', next)
    return refresh(next)
  }, [refresh])

  return { email, active, checking, refresh, linkEmail }
}
