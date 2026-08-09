import { useState, useEffect, useCallback } from 'react'
import { TrendingUp, Lock, RefreshCw } from 'lucide-react'
import { API_URL } from '../lib/api'

const money = n => `$${(Number(n) || 0).toFixed(2)}`

function Stat({ label, value, sub, accent = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-2xl font-bold ${accent}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

/**
 * Owner-only view of what the app is actually earning.
 *
 * Two numbers matter and they are deliberately shown side by side:
 *  - Booked commission: real money, from affiliate conversion postbacks.
 *  - Estimated: clicks x assumed conversion rate. A planning number only.
 * Never report the estimate as revenue.
 */
export default function RevenueDashboard() {
  const [token, setToken] = useState(() => sessionStorage.getItem('adminToken') || '')
  const [input, setInput] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(30)

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/revenue?days=${days}`, {
        headers: { 'x-admin-token': token },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.hint || body.error || 'Request failed')
      setData(body)
    } catch (err) {
      setError(err.message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [token, days])

  useEffect(() => { load() }, [load])

  if (!token) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6 max-w-md">
        <div className="flex items-center gap-2 mb-3">
          <Lock className="text-gray-500" size={20} />
          <h2 className="text-xl font-bold">Revenue dashboard</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Enter your <code className="bg-gray-100 px-1 rounded">ADMIN_TOKEN</code>. It is kept in
          this tab only and never written to disk.
        </p>
        <form
          onSubmit={e => {
            e.preventDefault()
            sessionStorage.setItem('adminToken', input)
            setToken(input)
          }}
          className="flex gap-2"
        >
          <input
            type="password"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Admin token"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-4 py-2 rounded-lg">
            Unlock
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="text-green-600" size={22} />
          <h2 className="text-2xl font-bold">Revenue</h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value, 10))}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button
            onClick={load}
            className="bg-white border border-gray-300 rounded-lg p-2 hover:bg-gray-50"
            aria-label="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => { sessionStorage.removeItem('adminToken'); setToken('') }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Lock
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">{error}</div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat
              label="Booked commission"
              value={money(data.bookedCommission)}
              sub={`${data.bookedConversions} conversions · ${money(data.approvedCommission)} approved`}
              accent="text-green-600"
            />
            <Stat label="Pro MRR" value={money(data.mrr)} sub={`${data.proMembers} members @ ${money(data.proPrice)}`} accent="text-amber-600" />
            <Stat label="Click-outs" value={data.clicks} sub={`est. EPC ${money(data.estEpc)}`} />
            <Stat label="Email list" value={data.subscribers} sub="subscribers" accent="text-indigo-600" />
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
            <strong>{money(data.estRevenue)} estimated</strong> over the same window, assuming a{' '}
            {(data.assumedCvr * 100).toFixed(1)}% conversion rate. This is a planning figure, not
            earnings — trust booked commission once postbacks are flowing.
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="font-bold mb-3">Networks</h3>
            <div className="flex flex-wrap gap-2">
              {data.networks.map(net => (
                <span
                  key={net.key}
                  className={`text-xs font-semibold px-3 py-1 rounded-full ${
                    net.configured ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {net.configured ? '✓' : '○'} {net.label}
                </span>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Unconfigured networks pass clicks through untracked and earn nothing. Add the
              matching env var to switch one on.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="font-bold mb-3">Earning by store / partner</h3>
              {data.byStore.length === 0 ? (
                <p className="text-sm text-gray-500">No click-outs yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="pb-2">Source</th>
                      <th className="pb-2">Type</th>
                      <th className="pb-2 text-right">Clicks</th>
                      <th className="pb-2 text-right">Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStore.map(row => (
                      <tr key={`${row.store}-${row.kind}`} className="border-b last:border-0">
                        <td className="py-2 font-medium">{row.store}</td>
                        <td className="py-2 text-gray-500">{row.kind}</td>
                        <td className="py-2 text-right">{row.clicks}</td>
                        <td className="py-2 text-right">{money(row.estRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="font-bold mb-3">Top earning coupons</h3>
              {data.topCoupons.length === 0 ? (
                <p className="text-sm text-gray-500">No coupon click-outs yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.topCoupons.map(row => (
                    <li key={row.couponId} className="flex justify-between gap-3 border-b last:border-0 pb-2">
                      <span className="truncate">{row.title}</span>
                      <span className="shrink-0 text-gray-500">
                        {row.clicks} · {money(row.estRevenue)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
