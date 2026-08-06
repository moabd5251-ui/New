import { test, expect } from '@playwright/test'

test('should load the app', async ({ page }) => {
  await page.goto('http://localhost:5173')
  await expect(page.locator('h1')).toContainText('Coupon Clipper')
})

test('should display dashboard metrics', async ({ page }) => {
  await page.goto('http://localhost:5173')
  await expect(page.locator('text=Actual Savings')).toBeVisible()
  await expect(page.locator('text=Potential Savings')).toBeVisible()
})

test('should show coupon cards', async ({ page }) => {
  await page.goto('http://localhost:5173')
  const cards = page.locator('.bg-white.rounded-lg')
  const count = await cards.count()
  expect(count).toBeGreaterThan(0)
})

test('should clip a coupon', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Find and click first clip button
  const clipBtn = page.locator('button:has-text("Clip Coupon")').first()
  await clipBtn.click()

  // Check clipped count increased
  const clippedBtn = page.locator('button:has-text("My Clipped")')
  const text = await clippedBtn.textContent()
  expect(text).toContain('1')
})

test('should search coupons', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Clear default search and search for specific item
  const searchInput = page.locator('input[placeholder*="Search coupons"]')
  await searchInput.fill('milk')

  // Wait for results
  await page.waitForTimeout(500)

  // Should find milk coupon
  const results = await page.locator('text=Milk').count()
  expect(results).toBeGreaterThan(0)
})

test('should view clipped coupons tab', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Clip first coupon
  await page.locator('button:has-text("Clip Coupon")').first().click()
  await page.waitForTimeout(300)

  // Click My Clipped tab
  await page.locator('button:has-text("My Clipped")').click()
  await page.waitForTimeout(300)

  // Should show clipped coupons section
  await expect(page.locator('text=Your Clipped Coupons')).toBeVisible()
})

test('should mark coupon as used', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Clip a coupon
  await page.locator('button:has-text("Clip Coupon")').first().click()
  await page.waitForTimeout(300)

  // Go to clipped tab
  await page.locator('button:has-text("My Clipped")').click()
  await page.waitForTimeout(300)

  // Mark as used
  await page.locator('button:has-text("Mark Used")').first().click()
  await page.waitForTimeout(300)

  // Check Used History tab
  await page.locator('button:has-text("Used History")').click()
  await page.waitForTimeout(300)

  // Should have used coupons
  await expect(page.locator('text=Used Coupons History')).toBeVisible()
})

test('should manage price alerts', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Click alerts tab
  await page.locator('button:has-text("Price Alerts")').click()
  await page.waitForTimeout(300)

  // Click new alert
  await page.locator('button:has-text("New Alert")').click()
  await page.waitForTimeout(300)

  // Fill form
  await page.locator('input[placeholder*="Product"]').fill('Orange Juice')
  await page.locator('input[placeholder*="3.50"]').fill('2.50')
  await page.locator('input[placeholder*="Safeway"]').fill('Safeway')

  // Submit
  await page.locator('button:has-text("Create Alert")').click()
  await page.waitForTimeout(300)

  // Verify alert created
  await expect(page.locator('text=Orange Juice')).toBeVisible()
})

test('should persist data in localStorage', async ({ page }) => {
  await page.goto('http://localhost:5173')

  // Clip a coupon
  await page.locator('button:has-text("Clip Coupon")').first().click()
  await page.waitForTimeout(300)

  // Check localStorage
  const clipped = await page.evaluate(() => {
    return JSON.parse(localStorage.getItem('clippedCoupons') || '[]')
  })

  expect(clipped.length).toBeGreaterThan(0)
})
