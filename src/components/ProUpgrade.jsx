import { useState } from 'react'
import { Crown, Check, X } from 'lucide-react'
import { API_URL } from '../lib/api'
import { PRO_PRICE, PRO_FEATURES } from '../lib/pro'

/** Inline nudge shown when a free user hits a limit. */
export function ProLimitNotice({ message, onUpgrade }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start justify-between gap-4">
      <div className="flex items-start gap-2">
        <Crown className="text-amber-500 shrink-0 mt-0.5" size={18} />
        <p className="text-sm text-amber-900">{message}</p>
      </div>
      <button
        onClick={onUpgrade}
        className="shrink-0 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
      >
        Upgrade
      </button>
    </div>
  )
}

export default function ProUpgrade({ isOpen, onClose, onLinkEmail, active }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')

  if (!isOpen) return null

  const startCheckout = async (e) => {
    e.preventDefault()
    setState('loading')
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/pro/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.hint || data.error || 'Checkout unavailable')
      await onLinkEmail(email)
      window.location.href = data.url
    } catch (err) {
      setError(err.message)
      setState('idle')
    }
  }

  const restore = async () => {
    setState('loading')
    setError('')
    const ok = await onLinkEmail(email)
    setState('idle')
    if (ok) onClose()
    else setError('No active subscription found for that email.')
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-2">
            <Crown className="text-amber-500" size={24} />
            <h2 className="text-2xl font-bold">Coupon Clipper Pro</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={22} />
          </button>
        </div>

        {active ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="font-semibold text-green-900">Pro is active on this device.</p>
            <p className="text-sm text-green-700 mt-1">Every limit is lifted. Thanks for supporting the app.</p>
          </div>
        ) : (
          <>
            <p className="text-gray-600 mb-4">
              The average user here clips <strong>$40+</strong> in coupons a month.
              Pro costs {PRO_PRICE} — it pays for itself on one grocery run.
            </p>

            <ul className="space-y-2 mb-6">
              {PRO_FEATURES.map(feature => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <Check className="text-green-600 shrink-0 mt-0.5" size={16} />
                  <span className="text-gray-700">{feature}</span>
                </li>
              ))}
            </ul>

            <form onSubmit={startCheckout} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={state === 'loading'}
                className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition disabled:opacity-60"
              >
                {state === 'loading' ? 'Starting…' : `Upgrade — ${PRO_PRICE}`}
              </button>
              <button
                type="button"
                onClick={restore}
                className="w-full text-sm text-gray-500 hover:text-indigo-600"
              >
                Already subscribed? Restore with this email
              </button>
            </form>

            {error && (
              <p className="text-sm text-red-600 mt-3 bg-red-50 border border-red-200 rounded p-2">{error}</p>
            )}

            <p className="text-xs text-gray-400 mt-4">
              Cancel anytime. Billing handled by Stripe — we never see your card details.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
