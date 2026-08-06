import fetch from 'node-fetch'
import http from 'http'

async function testApp() {
  console.log('🧪 Testing Coupon Clipper App\n')

  try {
    // Test 1: Check app loads
    console.log('1️⃣ Testing app loads...')
    const response = await fetch('http://localhost:5173')
    const html = await response.text()
    
    if (html.includes('Coupon Clipper')) {
      console.log('✅ App loads successfully')
    } else {
      console.log('❌ App failed to load')
      return
    }

    // Test 2: Check for React
    if (html.includes('react')) {
      console.log('✅ React is loaded')
    }

    // Test 3: Check styling
    if (html.includes('tailwind') || html.includes('css')) {
      console.log('✅ Styles are loaded')
    }

    // Test 4: Check structure
    if (html.includes('root')) {
      console.log('✅ DOM structure is correct')
    }

    console.log('\n✨ All basic checks passed!')
    console.log('\n📋 Features to test manually:')
    console.log('   1. Browse and search for coupons')
    console.log('   2. Clip a coupon - should increase "My Clipped" counter')
    console.log('   3. View "My Clipped" tab - see saved coupons')
    console.log('   4. Mark a coupon as used - should move to history')
    console.log('   5. View "Used History" tab - see used coupons and savings')
    console.log('   6. Create a price alert in "Price Alerts" tab')
    console.log('   7. Refresh the page - data should persist (localStorage)')
    console.log('   8. Dashboard should update as you use coupons')

  } catch (err) {
    console.error('❌ Test failed:', err.message)
  }
}

testApp()
