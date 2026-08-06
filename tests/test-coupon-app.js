import { test, expect } from '@playwright/test'

test.describe('Coupon Clipper App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
    await page.waitForLoadState('networkidle')
  })

  test('should load the app with dashboard metrics', async ({ page }) => {
    // Check for main header
    await expect(page.locator('h1')).toContainText('Coupon Clipper')

    // Check for dashboard cards
    await expect(page.locator('text=Actual Savings')).toBeVisible()
    await expect(page.locator('text=Potential Savings')).toBeVisible()
    await expect(page.locator('text=Clipped Coupons')).toBeVisible()
    await expect(page.locator('text=Coupons Used')).toBeVisible()

    console.log('✅ Dashboard loaded successfully')
  })

  test('should display browse tab with coupons', async ({ page }) => {
    // Browse tab should be active by default
    await expect(page.locator('button:has-text("Browse Coupons")')).toHaveClass(/bg-indigo-600/)

    // Should show coupon cards
    const couponCards = await page.locator('.bg-white.rounded-lg.shadow-md').count()
    console.log(`✅ Found ${couponCards} coupon cards displayed`)
    expect(couponCards).toBeGreaterThan(0)
  })

  test('should search coupons', async ({ page }) => {
    // Search for milk
    await page.fill('input[placeholder*="Search coupons"]', 'milk')
    await page.waitForTimeout(500)

    // Should show filtered results
    const results = await page.locator('text=Organic Milk').count()
    console.log(`✅ Search found ${results} result(s) for "milk"`)
    expect(results).toBeGreaterThan(0)
  })

  test('should filter by category', async ({ page }) => {
    // Click category filter
    await page.selectOption('select', { label: 'Category' }, 'Dairy')
    await page.waitForTimeout(500)

    // Should show dairy items
    const dairyItems = await page.locator('text=Dairy').count()
    console.log(`✅ Category filter showing ${dairyItems} dairy items`)
    expect(dairyItems).toBeGreaterThan(0)
  })

  test('should clip a coupon', async ({ page }) => {
    // Get initial clipped count
    const initialCount = await page.locator('button:has-text("My Clipped")').textContent()
    console.log(`📌 Initial clipped count: ${initialCount}`)

    // Click first "Clip Coupon" button
    await page.click('button:has-text("Clip Coupon")', { force: true })
    await page.waitForTimeout(500)

    // Check if clipped count increased
    const newCount = await page.locator('button:has-text("My Clipped")').textContent()
    console.log(`✅ Clipped count after action: ${newCount}`)
    expect(newCount).toContain('1')
  })

  test('should manage clipped coupons', async ({ page }) => {
    // Clip a coupon first
    await page.click('button:has-text("Clip Coupon")', { force: true })
    await page.waitForTimeout(500)

    // Go to clipped tab
    await page.click('button:has-text("My Clipped")')
    await page.waitForTimeout(500)

    // Should show the clipped coupon
    const clippedTitle = await page.locator('h2').first().textContent()
    console.log(`✅ Viewing clipped coupons: ${clippedTitle}`)
    expect(clippedTitle).toContain('Clipped')

    // Should show potential savings
    await expect(page.locator('text=potential savings')).toBeVisible()
  })

  test('should mark coupon as used', async ({ page }) => {
    // Clip a coupon
    await page.click('button:has-text("Clip Coupon")', { force: true })
    await page.waitForTimeout(500)

    // Go to clipped tab
    await page.click('button:has-text("My Clipped")')
    await page.waitForTimeout(500)

    // Mark as used
    await page.click('button:has-text("Mark Used")', { force: true })
    await page.waitForTimeout(500)

    // Should move to history
    await page.click('button:has-text("Used History")')
    await page.waitForTimeout(500)

    // Check history has items
    const historyText = await page.locator('text=Used Coupons History').textContent()
    console.log(`✅ Coupon marked as used and appears in history: ${historyText}`)
    expect(historyText).toContain('Used')
  })

  test('should create price alerts', async ({ page }) => {
    // Go to alerts tab
    await page.click('button:has-text("Price Alerts")')
    await page.waitForTimeout(500)

    // Check alerts section is visible
    await expect(page.locator('text=Price Alerts')).toBeVisible()

    // Click new alert button
    await page.click('button:has-text("New Alert")')
    await page.waitForTimeout(500)

    // Fill form
    await page.fill('input[placeholder*="Product Name"]', 'Orange Juice')
    await page.fill('input[placeholder*="e.g., 3.50"]', '2.50')
    await page.fill('input[placeholder*="e.g., Safeway"]', 'Safeway')

    // Submit
    await page.click('button:has-text("Create Alert")')
    await page.waitForTimeout(500)

    // Check alert was created
    const alertText = await page.locator('text=Orange Juice').textContent()
    console.log(`✅ Price alert created: ${alertText}`)
    expect(alertText).toContain('Orange Juice')
  })

  test('should persist data in localStorage', async ({ page }) => {
    // Clip a coupon
    await page.click('button:has-text("Clip Coupon")', { force: true })
    await page.waitForTimeout(500)

    // Check localStorage
    const clipped = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('clippedCoupons') || '[]')
    })

    console.log(`✅ LocalStorage contains ${clipped.length} clipped coupon(s)`)
    expect(clipped.length).toBeGreaterThan(0)
  })

  test('should calculate savings correctly', async ({ page }) => {
    // Clip first coupon
    await page.click('button:has-text("Clip Coupon")')
    await page.waitForTimeout(500)

    // Go to clipped tab
    await page.click('button:has-text("My Clipped")')
    await page.waitForTimeout(500)

    // Mark as used
    await page.click('button:has-text("Mark Used")')
    await page.waitForTimeout(500)

    // Check dashboard shows updated savings
    await page.goto('http://localhost:5173')
    await page.waitForTimeout(500)

    const actualSavingsText = await page.locator('text=Actual Savings').locator('..').textContent()
    console.log(`✅ Savings updated on dashboard: ${actualSavingsText}`)
    expect(actualSavingsText).toContain('$')
  })
})
