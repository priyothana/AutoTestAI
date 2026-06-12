/**
 * debug-crm-buttons.ts
 * Minimal diagnostic: login to CRM, visit /leads, dump ALL visible button texts.
 * Run: npx tsx src/scripts/debug-crm-buttons.ts
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import prisma from '../shared/db/prisma.js'
import { fernetDecrypt } from '../shared/encryption/fernet.js'

const PROJECT_ID = '038509ef-a142-409d-9d21-06dcdb48f368'

async function main() {
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: PROJECT_ID, category: 'web_app' },
  })
  const baseUrl = integration?.base_url?.replace(/\/$/, '') ?? ''
  let username = integration?.username ?? ''
  let password = integration?.password ?? ''
  try { username = fernetDecrypt(username) } catch { /* plaintext */ }
  try { password = fernetDecrypt(password) } catch { /* plaintext */ }

  console.log(`Base URL: ${baseUrl}`)
  console.log(`User: ${username}`)

  const browser = await chromium.launch({ headless: true })
  const ctx     = await browser.newContext()
  const page    = await ctx.newPage()

  // Login
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  for (const sel of ['input[type="email"]', 'input[name="username"]', 'input[type="text"]']) {
    const f = page.locator(sel).first()
    if (await f.isVisible({ timeout: 1000 }).catch(() => false)) { await f.fill(username); break }
  }
  await page.locator('input[type="password"]').first().fill(password)
  const btn = page.getByRole('button', { name: /log in|sign in|submit/i })
  await btn.first().click()
  await page.waitForTimeout(3000)
  console.log(`After login: ${page.url()}`)

  // Visit /leads
  await page.goto(`${baseUrl}/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1000)

  console.log(`\nPage URL: ${page.url()}`)
  console.log(`Page title: ${await page.title()}`)

  // Extract ALL visible buttons with full details
  const buttons = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('button, [role="button"], a[role="button"], input[type="submit"]') as NodeListOf<HTMLElement>
    ).filter(el => el.offsetParent !== null)

    return els.slice(0, 80).map((el, i) => {
      const innerText = ((el as HTMLButtonElement).innerText || '').trim()
      const value     = ((el as HTMLInputElement).value || '').trim()
      const ariaLabel = el.getAttribute('aria-label') || ''
      const testid    = el.getAttribute('data-testid') || ''
      const className = el.className?.toString().slice(0, 50) || ''
      return {
        i,
        tag:       el.tagName,
        text:      innerText.split('\n')[0].slice(0, 60),
        fullText:  innerText.slice(0, 120),
        value:     value.slice(0, 40),
        ariaLabel: ariaLabel.slice(0, 60),
        testid:    testid.slice(0, 40),
        class:     className,
      }
    })
  })

  console.log(`\n=== ALL VISIBLE BUTTONS on /leads (${buttons.length} total) ===`)
  for (const b of buttons) {
    console.log(`[${b.i}] tag=${b.tag} text="${b.text}" aria="${b.ariaLabel}" testid="${b.testid}" class="${b.class}"`)
    if (b.fullText && b.fullText !== b.text) {
      console.log(`     fullText: ${b.fullText.slice(0, 80)}`)
    }
  }

  await browser.close()
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
