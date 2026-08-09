export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

/**
 * Stable anonymous ID so we can tell "50 clicks from one person" apart from
 * "50 clicks from 50 people" — the difference between a real EPC and a
 * flattering one. Nothing personally identifying is stored.
 */
export function getSessionId() {
  const KEY = 'ccSessionId'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(KEY, id)
  }
  return id
}

/** Every outbound link goes through the server so attribution survives ad blockers. */
export function couponOfferUrl(couponId) {
  return `${API_URL}/api/go/${couponId}?s=${encodeURIComponent(getSessionId())}`
}

export function partnerOfferUrl(offerKey) {
  return `${API_URL}/api/go/offer/${encodeURIComponent(offerKey)}?s=${encodeURIComponent(getSessionId())}`
}

export function trackImpressions(couponIds) {
  if (!couponIds.length) return
  fetch(`${API_URL}/api/track/impressions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ couponIds }),
    keepalive: true,
  }).catch(() => {})
}
