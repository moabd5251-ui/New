import { useState, useEffect } from 'react'
import CouponList from './components/CouponList'
import ClippedCoupons from './components/ClippedCoupons'
import SearchBar from './components/SearchBar'
import SavingsCalculator from './components/SavingsCalculator'
import PriceAlerts from './components/PriceAlerts'

export default function App() {
  const [coupons, setCoupons] = useState([])
  const [clipped, setClipped] = useState([])
  const [used, setUsed] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [storeFilter, setStoreFilter] = useState('All')
  const [tab, setTab] = useState('browse')
  const [categories, setCategories] = useState([])
  const [stores, setStores] = useState([])
  const [loading, setLoading] = useState(true)

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

  // Fetch coupons from API
  useEffect(() => {
    fetchCoupons()
    fetchStores()
    fetchCategories()
  }, [])

  const fetchCoupons = async () => {
    try {
      setLoading(true)
      const response = await fetch(`${API_URL}/api/coupons`)
      const data = await response.json()
      setCoupons(data)
    } catch (err) {
      console.error('Failed to fetch coupons:', err)
      // Fallback to empty if API unavailable
      setCoupons([])
    } finally {
      setLoading(false)
    }
  }

  const fetchStores = async () => {
    try {
      const response = await fetch(`${API_URL}/api/coupons/stores`)
      const data = await response.json()
      setStores(['All', ...data])
    } catch (err) {
      console.error('Failed to fetch stores:', err)
    }
  }

  const fetchCategories = async () => {
    try {
      const response = await fetch(`${API_URL}/api/coupons/categories`)
      const data = await response.json()
      setCategories(['All', ...data])
    } catch (err) {
      console.error('Failed to fetch categories:', err)
    }
  }

  // Load saved data from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('clippedCoupons')
    const usedSaved = localStorage.getItem('usedCoupons')
    if (saved) setClipped(JSON.parse(saved))
    if (usedSaved) setUsed(JSON.parse(usedSaved))
  }, [])

  useEffect(() => {
    localStorage.setItem('clippedCoupons', JSON.stringify(clipped))
  }, [clipped])

  useEffect(() => {
    localStorage.setItem('usedCoupons', JSON.stringify(used))
  }, [used])

  const filteredCoupons = coupons.filter(coupon => {
    const matchesSearch = coupon.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         coupon.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesCategory = categoryFilter === 'All' || coupon.category === categoryFilter
    const matchesStore = storeFilter === 'All' || coupon.store === storeFilter
    const notClipped = !clipped.find(c => c.id === coupon.id)
    return matchesSearch && matchesCategory && matchesStore && notClipped
  })

  const clipCoupon = (coupon) => {
    setClipped([...clipped, coupon])
  }

  const unclipCoupon = (couponId) => {
    setClipped(clipped.filter(c => c.id !== couponId))
  }

  const markAsUsed = (couponId) => {
    const coupon = clipped.find(c => c.id === couponId)
    if (coupon) {
      setUsed([...used, { ...coupon, usedAt: new Date().toISOString() }])
      unclipCoupon(couponId)
    }
  }

  const totalSavings = used.reduce((sum, c) => sum + c.discount, 0)
  const potentialSavings = clipped.reduce((sum, c) => sum + c.discount, 0)

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <nav className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-3xl font-bold text-indigo-600">💰 Coupon Clipper</h1>
          <p className="text-gray-600">Smart savings at your fingertips</p>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <SavingsCalculator
          totalSavings={totalSavings}
          potentialSavings={potentialSavings}
          usedCount={used.length}
          clippedCount={clipped.length}
        />

        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setTab('browse')}
            className={`px-6 py-2 rounded-lg font-semibold transition ${
              tab === 'browse'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Browse Coupons
          </button>
          <button
            onClick={() => setTab('clipped')}
            className={`px-6 py-2 rounded-lg font-semibold transition ${
              tab === 'clipped'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            My Clipped ({clipped.length})
          </button>
          <button
            onClick={() => setTab('history')}
            className={`px-6 py-2 rounded-lg font-semibold transition ${
              tab === 'history'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Used History ({used.length})
          </button>
          <button
            onClick={() => setTab('alerts')}
            className={`px-6 py-2 rounded-lg font-semibold transition ${
              tab === 'alerts'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Price Alerts
          </button>
        </div>

        {tab === 'browse' && (
          <div className="space-y-6">
            {loading && (
              <div className="bg-blue-100 border border-blue-400 text-blue-800 px-4 py-3 rounded">
                ⏳ Loading fresh coupons from Seattle-area stores...
              </div>
            )}
            <SearchBar
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              categories={categories}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              stores={stores}
              storeFilter={storeFilter}
              setStoreFilter={setStoreFilter}
            />
            <CouponList
              coupons={filteredCoupons}
              onClip={clipCoupon}
              action="clip"
            />
          </div>
        )}

        {tab === 'clipped' && (
          <ClippedCoupons
            coupons={clipped}
            onUnclip={unclipCoupon}
            onMarkAsUsed={markAsUsed}
          />
        )}

        {tab === 'history' && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold mb-4">Used Coupons History</h2>
            {used.length === 0 ? (
              <p className="text-gray-500">No used coupons yet. Start clipping!</p>
            ) : (
              <div className="space-y-4">
                {used.map(coupon => (
                  <div key={coupon.id} className="border-l-4 border-green-500 pl-4 py-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-semibold text-lg">{coupon.title}</h3>
                        <p className="text-sm text-gray-600">{coupon.store} • {coupon.category}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-green-600">+${coupon.discount.toFixed(2)}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(coupon.usedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'alerts' && (
          <PriceAlerts />
        )}
      </div>
    </div>
  )
}
