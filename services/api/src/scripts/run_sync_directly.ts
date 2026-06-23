import { PrismaClient } from '@prisma/client'
import { crawlAndStoreRaw, normalizeWebappMetadata, buildWebappDomainModels } from '../modules/webapp/webapp.service.js'
import { buildCanonicalMetadata, populateOpenButtonsFromCrawlData } from '../modules/webapp/canonical-builder.service.js'
import { generateEmbeddings } from '../modules/salesforce/salesforce.embeddings.js'
import { extractTestData } from '../modules/webapp/webapp-test-data.service.js'

const prisma = new PrismaClient()

async function main() {
  const projectId = '5006cc44-0e03-45bd-8a84-3b2582f84b02'
  console.log(`[DIRECT-SYNC] Starting sync directly for project ${projectId}`)

  // 1. Stage 1: Crawl with continuation loop
  console.log('[DIRECT-SYNC] Stage 1/5: Crawling...')
  let crawlResult = await crawlAndStoreRaw(projectId, false)
  console.log('[DIRECT-SYNC] Initial crawl run done:', {
    pagesCrawledThisRun: crawlResult.pagesCrawledThisRun,
    totalCrawledSoFar: crawlResult.totalCrawledSoFar,
    hasMorePages: crawlResult.hasMorePages,
    pendingCount: crawlResult.pendingCount
  })

  let continuationCount = 1
  while (crawlResult.hasMorePages && continuationCount <= 10) {
    console.log(`[DIRECT-SYNC] Continuation run #${continuationCount}...`)
    crawlResult = await crawlAndStoreRaw(projectId, true)
    console.log(`[DIRECT-SYNC] Continuation run #${continuationCount} result:`, {
      pagesCrawledThisRun: crawlResult.pagesCrawledThisRun,
      totalCrawledSoFar: crawlResult.totalCrawledSoFar,
      hasMorePages: crawlResult.hasMorePages,
      pendingCount: crawlResult.pendingCount
    })
    continuationCount++
  }

  // 2. Stage 2: Normalize
  console.log('[DIRECT-SYNC] Stage 2/5: Normalizing...')
  const normalizedCount = await normalizeWebappMetadata(projectId)
  console.log(`[DIRECT-SYNC] Stage 2 done — ${normalizedCount} normalized records`)

  // 3. Stage 3: Domain models
  console.log('[DIRECT-SYNC] Stage 3/5: Building domain models...')
  const domainCount = await buildWebappDomainModels(projectId)
  console.log(`[DIRECT-SYNC] Stage 3 done — ${domainCount} domain models`)

  // 4. Stage 3.5: Canonical builder
  console.log('[DIRECT-SYNC] Stage 3.5/5: Building canonical metadata...')
  const canonicalCount = await buildCanonicalMetadata(projectId)
  console.log(`[DIRECT-SYNC] Stage 3.5 done — ${canonicalCount} canonical records`)

  // 5. Stage 3.6: Open buttons
  console.log('[DIRECT-SYNC] Stage 3.6/5: Populating open buttons...')
  const openBtnCount = await populateOpenButtonsFromCrawlData(projectId)
  console.log(`[DIRECT-SYNC] Stage 3.6 done — ${openBtnCount} open buttons updated`)

  // 6. Stage 4: Embeddings
  console.log('[DIRECT-SYNC] Stage 4/5: Generating embeddings...')
  const embeddingCount = await generateEmbeddings(projectId)
  console.log(`[DIRECT-SYNC] Stage 4 done — ${embeddingCount} embeddings`)

  // 7. Stage 5: Test data
  console.log('[DIRECT-SYNC] Stage 5/5: Extracting test data...')
  try {
    const testDataCount = await extractTestData(projectId)
    console.log(`[DIRECT-SYNC] Stage 5 done — ${testDataCount} test data records`)
  } catch (err) {
    console.warn('[DIRECT-SYNC] Stage 5 failed (non-critical):', err)
  }

  console.log('[DIRECT-SYNC] Metadata sync completed successfully!')
}

main().catch(console.error).finally(() => prisma.$disconnect())
