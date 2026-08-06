import CouponCard from './CouponCard'

export default function CouponList({ coupons, onClip, onUnclip, onMarkAsUsed, action = 'clip' }) {
  if (coupons.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-md p-12 text-center">
        <p className="text-xl text-gray-500">No coupons found. Try adjusting your filters!</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {coupons.map(coupon => (
        <CouponCard
          key={coupon.id}
          coupon={coupon}
          onClip={onClip}
          onUnclip={onUnclip}
          onMarkAsUsed={onMarkAsUsed}
          action={action}
        />
      ))}
    </div>
  )
}
