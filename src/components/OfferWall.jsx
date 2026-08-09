import { useState, useEffect } from 'react'
import { ExternalLink, Layers } from 'lucide-react'
import { API_URL, partnerOfferUrl } from '../lib/api'

/**
 * Partner offers — the highest-earning surface in the app.
 *
 * A grocery coupon click is worth cents. A cashback-app or delivery signup
 * from someone who is *already* clipping coupons pays $3-$30 once. This block
 * is placed where intent is highest: right after a coupon is clipped.
 */
export default function OfferWall({ variant = 'full', title }) {
  const [offers, setOffers] = useState([])

  useEffect(() => {
    fetch(`${API_URL}/api/offers`)
      .then(res => res.json())
      .then(data => setOffers(Array.isArray(data) ? data : []))
      .catch(() => setOffers([]))
  }, [])

  if (!offers.length) return null

  const shown = variant === 'compact' ? offers.slice(0, 3) : offers

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex items-center gap-2 mb-1">
        <Layers className="text-indigo-600" size={20} />
        <h2 className="text-xl font-bold">{title || 'Stack more savings on top'}</h2>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        These stack with the coupons you just clipped — same groceries, more money back.
      </p>

      <div className={`grid gap-4 ${variant === 'compact' ? 'md:grid-cols-3' : 'md:grid-cols-2 lg:grid-cols-3'}`}>
        {shown.map(offer => (
          <a
            key={offer.key}
            href={partnerOfferUrl(offer.key)}
            target="_blank"
            rel="sponsored noopener noreferrer"
            className="border border-gray-200 rounded-lg p-4 hover:border-indigo-400 hover:shadow-md transition group"
          >
            <div className="flex items-start justify-between mb-2">
              <span className="text-3xl">{offer.icon}</span>
              <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-1 rounded">
                {offer.category}
              </span>
            </div>
            <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-1">
              {offer.name}
              <ExternalLink size={14} className="text-gray-400 group-hover:text-indigo-600" />
            </h3>
            <p className="text-sm text-gray-600">{offer.blurb}</p>
          </a>
        ))}
      </div>

      <p className="text-xs text-gray-400 mt-4">
        Partner links — we may earn a commission if you sign up, at no cost to you.
      </p>
    </div>
  )
}
