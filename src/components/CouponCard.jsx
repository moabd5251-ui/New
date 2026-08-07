import { Trash2, CheckCircle } from 'lucide-react'

export default function CouponCard({ coupon, onClip, onUnclip, onMarkAsUsed, action = 'clip' }) {
  const daysUntilExpiry = Math.ceil(
    (new Date(coupon.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)
  )

  const getExpiryColor = () => {
    if (daysUntilExpiry <= 3) return 'text-red-600'
    if (daysUntilExpiry <= 7) return 'text-orange-600'
    return 'text-green-600'
  }

  return (
    <div className="bg-white rounded-lg shadow-md hover:shadow-lg transition overflow-hidden">
      <div className="bg-gradient-to-r from-indigo-400 to-indigo-600 p-6 flex items-center justify-center min-h-24">
        <span className="text-6xl">{coupon.image}</span>
      </div>

      <div className="p-4">
        <div className="mb-3">
          <h3 className="font-bold text-lg leading-tight mb-1">{coupon.title}</h3>
          <p className="text-sm text-gray-600 mb-2">{coupon.description}</p>
        </div>

        {coupon.couponCode && (
          <div className="mb-4 flex flex-col items-center gap-2">
            <div className="bg-white p-3 rounded border-2 border-indigo-300">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(coupon.couponCode)}`}
                alt="QR Code"
                className="w-32 h-32"
              />
            </div>
            <div className="bg-gray-50 p-2 rounded border border-gray-200 w-full text-center">
              <p className="text-xs text-gray-500 mb-1">Scan or enter code:</p>
              <p className="font-mono font-bold text-sm text-gray-800">{coupon.couponCode}</p>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center mb-3">
          <span className="text-xs font-semibold bg-indigo-100 text-indigo-800 px-2 py-1 rounded">
            {coupon.category}
          </span>
          <span className="text-xs font-semibold bg-gray-100 text-gray-800 px-2 py-1 rounded">
            {coupon.store}
          </span>
        </div>

        <div className="border-t pt-3 mb-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-2xl font-bold text-green-600">
              ${coupon.discount.toFixed(2)}
            </span>
            <span className={`text-xs font-semibold ${getExpiryColor()}`}>
              {daysUntilExpiry <= 0 ? 'Expired' : `${daysUntilExpiry}d left`}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          {action === 'clip' ? (
            <button
              onClick={() => onClip(coupon)}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 rounded-lg transition"
            >
              Clip Coupon
            </button>
          ) : (
            <>
              <button
                onClick={() => onMarkAsUsed(coupon.id)}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
              >
                <CheckCircle size={16} />
                Mark Used
              </button>
              <button
                onClick={() => onUnclip(coupon.id)}
                className="bg-red-100 hover:bg-red-200 text-red-600 p-2 rounded-lg transition"
              >
                <Trash2 size={18} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
