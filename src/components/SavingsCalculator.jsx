import { TrendingUp, Wallet, ShoppingCart, CheckCircle } from 'lucide-react'

export default function SavingsCalculator({
  totalSavings,
  potentialSavings,
  usedCount,
  clippedCount,
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-600 text-sm font-semibold">Actual Savings</p>
            <p className="text-3xl font-bold text-green-600 mt-2">
              ${totalSavings.toFixed(2)}
            </p>
            <p className="text-xs text-gray-500 mt-1">{usedCount} coupons used</p>
          </div>
          <TrendingUp className="text-green-600" size={32} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-600 text-sm font-semibold">Potential Savings</p>
            <p className="text-3xl font-bold text-indigo-600 mt-2">
              ${potentialSavings.toFixed(2)}
            </p>
            <p className="text-xs text-gray-500 mt-1">{clippedCount} coupons clipped</p>
          </div>
          <Wallet className="text-indigo-600" size={32} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-600 text-sm font-semibold">Clipped Coupons</p>
            <p className="text-3xl font-bold text-blue-600 mt-2">{clippedCount}</p>
            <p className="text-xs text-gray-500 mt-1">Ready to use</p>
          </div>
          <ShoppingCart className="text-blue-600" size={32} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-600 text-sm font-semibold">Coupons Used</p>
            <p className="text-3xl font-bold text-purple-600 mt-2">{usedCount}</p>
            <p className="text-xs text-gray-500 mt-1">This month</p>
          </div>
          <CheckCircle className="text-purple-600" size={32} />
        </div>
      </div>
    </div>
  )
}
