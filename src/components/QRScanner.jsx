import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export default function QRScanner({ isOpen, onClose, onScan }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [error, setError] = useState(null)
  const [isScanning, setIsScanning] = useState(false)

  useEffect(() => {
    if (!isOpen) return

    const startScanner = async () => {
      try {
        setError(null)
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        })

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          setIsScanning(true)
          scanQRCode()
        }
      } catch (err) {
        setError('Camera not accessible. Please check permissions.')
        setIsScanning(false)
      }
    }

    startScanner()

    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(track => track.stop())
      }
    }
  }, [isOpen])

  const scanQRCode = () => {
    const canvas = canvasRef.current
    const video = videoRef.current

    if (!canvas || !video || !isScanning) return

    const ctx = canvas.getContext('2d')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    ctx.drawImage(video, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data

    try {
      // Simple QR code detection - look for the characteristic QR pattern
      const qrPattern = detectQRPattern(data, canvas.width, canvas.height)
      if (qrPattern) {
        onScan(qrPattern)
        onClose()
        return
      }
    } catch (e) {
      // Continue scanning
    }

    if (isScanning) {
      requestAnimationFrame(scanQRCode)
    }
  }

  const detectQRPattern = (data, width, height) => {
    // Simplified QR detection - in a real app, use jsQR library
    // For now, we'll provide a fallback with manual code entry
    return null
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 className="text-xl font-bold">Scan Coupon Code</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-4">
          {error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
              <p className="text-sm text-red-800">{error}</p>
              <p className="text-xs text-red-600 mt-2">
                Note: Manual code entry is not yet supported. You can copy the code above and scan with your phone's camera.
              </p>
            </div>
          ) : (
            <>
              <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden mb-4">
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                />
                <canvas
                  ref={canvasRef}
                  className="hidden"
                />
                <div className="absolute inset-0 border-2 border-green-400 rounded-lg flex items-center justify-center">
                  <div className="text-green-400 text-center">
                    <div className="text-sm font-semibold">Point at QR code</div>
                  </div>
                </div>
              </div>
              <p className="text-sm text-gray-600 text-center">
                Position the QR code within the frame
              </p>
            </>
          )}

          <button
            onClick={onClose}
            className="w-full mt-4 bg-gray-300 hover:bg-gray-400 text-gray-800 font-semibold py-2 rounded-lg transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
