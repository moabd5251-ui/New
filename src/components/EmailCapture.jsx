import { useState } from 'react'
import { Mail, Check } from 'lucide-react'
import { API_URL } from '../lib/api'

/**
 * The email list is the only asset here that compounds. Every other channel
 * costs money per visit; a subscriber can be monetized repeatedly for free.
 */
export default function EmailCapture({ source = 'app' }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setState('saving')
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Something went wrong')
      setState('done')
    } catch (err) {
      setError(err.message)
      setState('idle')
    }
  }

  if (state === 'done') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 flex items-center gap-3">
        <Check className="text-green-600" size={24} />
        <div>
          <p className="font-semibold text-green-900">You're on the list.</p>
          <p className="text-sm text-green-700">Your first deals digest lands next Thursday.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 rounded-lg p-6 text-white">
      <div className="flex items-center gap-2 mb-2">
        <Mail size={20} />
        <h2 className="text-xl font-bold">Get the week's best deals first</h2>
      </div>
      <p className="text-indigo-100 text-sm mb-4">
        One email a Thursday: the highest-value coupons before they expire, plus
        which ones stack. No spam, unsubscribe anytime.
      </p>

      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 px-4 py-2 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-white"
        />
        <button
          type="submit"
          disabled={state === 'saving'}
          className="bg-white text-indigo-700 font-semibold px-6 py-2 rounded-lg hover:bg-indigo-50 transition disabled:opacity-60"
        >
          {state === 'saving' ? 'Joining…' : 'Send me deals'}
        </button>
      </form>

      {error && <p className="text-sm text-red-200 mt-2">{error}</p>}
    </div>
  )
}
