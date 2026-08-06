import CouponList from './CouponList'

export default function ClippedCoupons({ coupons, onUnclip, onMarkAsUsed }) {
  const totalValue = coupons.reduce((sum, c) => sum + c.discount, 0)

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 text-white rounded-lg shadow-lg p-6">
        <h2 className="text-2xl font-bold mb-2">Your Clipped Coupons</h2>
        <p className="text-indigo-100">Total potential savings: <span className="text-3xl font-bold">${totalValue.toFixed(2)}</span></p>
      </div>

      <CouponList
        coupons={coupons}
        onUnclip={onUnclip}
        onMarkAsUsed={onMarkAsUsed}
        action="manage"
      />
    </div>
  )
}
