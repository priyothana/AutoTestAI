import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { join } from 'path';

const prisma = new PrismaClient();

async function main() {
  const projectId = '5006cc44-0e03-45bd-8a84-3b2582f84b02';
  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'web_app' }
  });

  if (!integration) {
    console.error("No integration found!");
    return;
  }

  const username = integration.username;
  const password = integration.password;
  const baseUrl = 'https://capricon.ds-logistics.datasirpi.com/';
  const targetUrl = 'https://capricon.ds-logistics.datasirpi.com/quotations/a2bbaa1d-bf84-4818-96bc-77ab6d27d9e7';

  console.log(`Launching browser. Base URL: ${baseUrl}`);
  console.log(`Using credentials: username=${username}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  
  // 1. Go to base URL first to log in
  console.log("Navigating to base URL...");
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log("Base page loaded. URL:", page.url());

  // Wait for page to render or redirect
  await page.waitForTimeout(2000);
  console.log("URL after wait:", page.url());
  
  // Check if we are on a login page
  const hasSignIn = await page.getByRole('button', { name: 'Sign In', exact: false }).isVisible().catch(() => false);
  console.log(`Is sign-in button visible? ${hasSignIn}`);
  
  if (hasSignIn) {
    console.log("Form login page detected. Attempting login...");
    
    // Fill username
    const usernameField = page.locator('input[type="email"], input[name="username"], input[name="email"], input[type="text"]').first();
    await usernameField.fill(username);
    
    // Fill password
    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.fill(password);
    
    // Click Sign In
    await page.getByRole('button', { name: 'Sign In', exact: false }).click();
    console.log("Clicked Sign In. Waiting for navigation...");
    
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    console.log("After login URL:", page.url());
  }

  // Navigate to target URL
  console.log(`Navigating to target URL: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log("Page loaded. URL:", page.url());
  console.log("Page title:", await page.title());

  // Log visible buttons
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .map(el => (el.textContent || '').trim())
      .filter(Boolean);
  });
  console.log("Visible buttons on page:", buttons);

  // Click the "Create Booking" button
  console.log("Clicking 'Create Booking' button...");
  
  const createBookingBtn = page.getByRole('button', { name: 'Create Booking', exact: true }).first();
  const exists = await createBookingBtn.isVisible().catch(() => false);
  console.log(`Does 'Create Booking' button exist and is visible? ${exists}`);
  
  if (exists) {
    await createBookingBtn.click();
    console.log("Clicked! Waiting 4 seconds for modal/dialog...");
    await page.waitForTimeout(4000);

    // Take screenshot of the screen state
    const screenshotPath = join('/Users/priyothanajose/Desktop/AITesting/AutoTestAI/services/api', 'booking_modal_clicked.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    // Inspect DOM for dialog/modals
    const bodyHtml = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .modal-dialog, [class*="modal"], [class*="drawer"]'))
        .map(el => {
          return {
            tagName: el.tagName,
            className: el.className,
            id: el.id,
            role: el.getAttribute('role'),
            ariaModal: el.getAttribute('aria-modal'),
            visible: (el as HTMLElement).offsetParent !== null,
            text: (el.textContent || '').slice(0, 300).trim(),
            inputs: Array.from(el.querySelectorAll('input, select, textarea')).map(input => ({
              type: input.tagName,
              name: input.getAttribute('name'),
              placeholder: input.getAttribute('placeholder'),
              label: input.getAttribute('aria-label') || ''
            }))
          };
        });
      return dialogs;
    });
    console.log("Detected dialog/modal elements in DOM:", JSON.stringify(bodyHtml, null, 2));
  } else {
    console.error("Could not find 'Create Booking' button on page!");
  }

  await context.close();
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
