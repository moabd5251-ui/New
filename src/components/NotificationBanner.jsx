import { X, Bell } from 'lucide-react'
import { useEffect, useState } from 'react'

export default function NotificationBanner({ notifications, onDismiss }) {
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {notifications.map((notif) => (
        <div
          key={notif.id}
          className="bg-green-50 border border-green-200 rounded-lg p-4 shadow-lg flex items-start gap-3 animate-slide-in"
        >
          <Bell className="text-green-600 flex-shrink-0 mt-1" size={20} />
          <div className="flex-1">
            <p className="font-semibold text-green-900">{notif.title}</p>
            <p className="text-sm text-green-700">{notif.message}</p>
          </div>
          <button
            onClick={() => onDismiss(notif.id)}
            className="text-green-600 hover:text-green-800 flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}
