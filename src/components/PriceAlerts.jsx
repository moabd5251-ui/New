import { useState } from 'react'
import { Bell, Plus, Trash2 } from 'lucide-react'
import { FREE_LIMITS } from '../lib/pro'
import { ProLimitNotice } from './ProUpgrade'

export default function PriceAlerts({ isPro = false, onUpgrade = () => {} }) {
  const [alerts, setAlerts] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    product: '',
    targetPrice: '',
    store: '',
  })

  const atLimit = !isPro && alerts.length >= FREE_LIMITS.alerts

  const handleSubmit = (e) => {
    e.preventDefault()
    if (atLimit) return
    if (formData.product && formData.targetPrice && formData.store) {
      setAlerts([...alerts, {
        id: Date.now(),
        ...formData,
        targetPrice: parseFloat(formData.targetPrice),
      }])
      setFormData({ product: '', targetPrice: '', store: '' })
      setShowForm(false)
    }
  }

  const removeAlert = (id) => {
    setAlerts(alerts.filter(a => a.id !== id))
  }

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Bell className="text-yellow-500" size={28} />
          Price Alerts
        </h2>
        <button
          onClick={() => (atLimit ? onUpgrade() : setShowForm(!showForm))}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition flex items-center gap-2"
        >
          <Plus size={20} />
          New Alert
        </button>
      </div>

      {atLimit && (
        <div className="mb-6">
          <ProLimitNotice
            message={`You've used all ${FREE_LIMITS.alerts} free price alerts. Pro tracks unlimited items.`}
            onUpgrade={onUpgrade}
          />
        </div>
      )}

      {showForm && !atLimit && (
        <form onSubmit={handleSubmit} className="bg-gray-50 p-4 rounded-lg mb-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Product Name
            </label>
            <input
              type="text"
              value={formData.product}
              onChange={(e) => setFormData({ ...formData, product: e.target.value })}
              placeholder="e.g., Organic Milk"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Target Price
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.targetPrice}
                onChange={(e) => setFormData({ ...formData, targetPrice: e.target.value })}
                placeholder="e.g., 3.50"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Store
              </label>
              <input
                type="text"
                value={formData.store}
                onChange={(e) => setFormData({ ...formData, store: e.target.value })}
                placeholder="e.g., Safeway"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                required
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition"
            >
              Create Alert
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-2 rounded-lg transition"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {alerts.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No price alerts set yet. Create one to be notified when prices drop!
        </p>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <div
              key={alert.id}
              className="flex items-center justify-between bg-yellow-50 border border-yellow-200 rounded-lg p-4"
            >
              <div>
                <h3 className="font-semibold text-gray-800">{alert.product}</h3>
                <p className="text-sm text-gray-600">
                  {alert.store} • Alert me when price drops below <span className="font-semibold">${alert.targetPrice.toFixed(2)}</span>
                </p>
              </div>
              <button
                onClick={() => removeAlert(alert.id)}
                className="text-red-600 hover:text-red-800 transition"
              >
                <Trash2 size={20} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>💡 Tip:</strong> Set price alerts for items you buy regularly. When a coupon or sale matches your alert, you'll know it's a great deal!
        </p>
      </div>
    </div>
  )
}
