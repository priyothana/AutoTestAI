import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { WebMetadataService } from './src/modules/webapp/webapp-crawler.js';

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

  console.log(`[TEST] Launching browser...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  
  // Inject the global __name fix immediately
  await context.addInitScript(() => {
    (window as any).__name = (fn: any) => fn;
  });

  const page = await context.newPage();
  
  // Login first
  console.log(`[TEST] Logging in at base URL...`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const hasSignIn = await page.getByRole('button', { name: 'Sign In', exact: false }).isVisible().catch(() => false);
  if (hasSignIn) {
    await page.locator('input[type="email"], input[name="username"], input[name="email"]').first().fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: false }).click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  console.log(`[TEST] Navigating to target quotation detail page...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  
  // Simulate _visitPage extraction of metadata
  console.log(`[TEST] Extracting page content metadata...`);
  const pageMeta = await WebMetadataService._extractPageContent(page, baseUrl);
  if (!pageMeta) {
    console.error("Failed to extract page content!");
    return;
  }
  
  console.log(`[TEST] Page buttons extracted:`, pageMeta.buttons.map(b => b.name));

  // Run _discoverModalForms
  console.log(`[TEST] Invoking _discoverModalForms...`);
  const runModalFingerprints = new Set<string>();
  const modalForms = await WebMetadataService._discoverModalForms(
    page,
    pageMeta,
    targetUrl,
    baseUrl,
    0,
    runModalFingerprints
  );

  console.log(`\n[TEST] Modal forms found: ${modalForms.length}`);
  for (const mf of modalForms) {
    console.log(`- URL: ${mf.url}`);
    console.log(`  Trigger: ${mf.modal_trigger_button}`);
    console.log(`  Inputs count: ${mf.inputs.length}`);
    console.log(`  Selects count: ${mf.selects.length}`);
    console.log(`  Buttons:`, mf.buttons.map(b => b.name));
  }

  await context.close();
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
