/**
 * rebuild-canonical.ts
 *
 * Fix 4: Re-run the full metadata normalization + canonical build pipeline
 * using the newly-crawled raw data (including Campaign, Contract, Order,
 * Invoice, Quote, Product form pages).
 *
 * Run: npx tsx src/scripts/rebuild-canonical.ts [projectId]
 */
import 'dotenv/config'
import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import { buildCanonicalMetadata } from '../modules/webapp/canonical-builder.service.js'
import { populateOpenButtonsFromCrawlData } from '../modules/webapp/canonical-builder.service.js'

const log = createModuleLogger('rebuild-canonical')

// ─── Types matching normalized page structure ────────────────────────────────

interface RawButton {
  name: string
  locator_type: string
  locator: string
  tag?: string
}

interface RawInput {
  name:         string
  tag:          string
  type:         string
  required:     boolean
  locator_type: string
  locator:      string
}

interface RawSelect {
  name:         string
  tag:          string
  type:         string
  required:     boolean
  locator_type: string
  locator:      string
  options:      string[]
}

interface PageSnapshot {
  url:      string
  path:     string
  title:    string
  headings: string[]
  inputs:   RawInput[]
  selects:  RawSelect[]
  buttons:  RawButton[]
  testids:  string[]
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function rebuildCanonical(projectId: string): Promise<void> {
  log.info(`[REBUILD] ▶ Starting canonical rebuild for project ${projectId}`)

  // 1. Load the raw store data
  const rawRecord = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' },
  })
  if (!rawRecord) { log.error('[REBUILD] No raw store data found — run crawler first'); return }

  const rawData = rawRecord.raw_json as unknown as { base_url: string; pages: PageSnapshot[] }
  const pages   = rawData.pages ?? []
  log.info(`[REBUILD] Raw data: ${pages.length} pages`)

  // 2. Build normalized structure (matches NormalizedWebPage in canonical-builder)
  // Map the crawler output format → normalized format
  const normalizedPages = pages.map(p => ({
    url:      p.url,
    path:     p.path,
    title:    p.title,
    headings: p.headings,
    inputs:   (p.inputs ?? []).map(inp => ({
      locator:      inp.locator || inp.name,
      required:     inp.required,
      type:         inp.type || inp.tag || 'text',
      locator_type: inp.locator_type || 'label',
      name:         inp.name,
      tag:          inp.tag,
    })),
    selects: (p.selects ?? []).map(sel => ({
      locator:      sel.locator || sel.name,
      required:     sel.required,
      options:      sel.options || [],
      locator_type: sel.locator_type || 'label',
      name:         sel.name,
      tag:          sel.tag,
    })),
    buttons: (p.buttons ?? []).map(btn => ({
      name:         btn.name,
      locator:      btn.locator,
      locator_type: btn.locator_type || 'role',
      role:         'button',
      tag:          btn.tag || 'button',
    })),
    testids: p.testids || [],
  }))

  const normalizedJson = { pages: normalizedPages, base_url: rawData.base_url }

  // 3. Upsert normalized record
  const existingNorm = await prisma.metadata_normalized.findFirst({
    where: { project_id: projectId, entity_type: 'webapp_crawl' },
  })

  if (existingNorm) {
    await prisma.metadata_normalized.update({
      where: { id: existingNorm.id },
      data:  { structured_json: normalizedJson as object },
    })
    log.info(`[REBUILD] Updated metadata_normalized (${normalizedPages.length} pages)`)
  } else {
    await prisma.metadata_normalized.create({
      data: {
        project_id:      projectId,
        entity_type:     'webapp_crawl',
        object_name:     rawData.base_url,
        structured_json: normalizedJson as object,
      },
    })
    log.info(`[REBUILD] Created metadata_normalized (${normalizedPages.length} pages)`)
  }

  // 4. Run canonical build (Stage 3.5)
  log.info('[REBUILD] Running buildCanonicalMetadata...')
  const upsertCount = await buildCanonicalMetadata(projectId)
  log.info(`[REBUILD] Canonical build done — ${upsertCount} records upserted`)

  // 5. Run open button population (Stage 3.6)
  log.info('[REBUILD] Running populateOpenButtonsFromCrawlData...')
  await populateOpenButtonsFromCrawlData(projectId)
  log.info('[REBUILD] Open buttons populated')

  // 6. Post-build: fix page_url to /entity/new (not /entity/create)
  await (prisma as any).$executeRaw`
    UPDATE metadata_canonical
    SET page_url = REPLACE(page_url, '/create', '/new')
    WHERE project_id = ${projectId}::uuid
      AND page_url LIKE '%/create'
  `
  log.info('[REBUILD] Fixed page_url: /create → /new')

  // 7. Update web_test_data button names from canonical
  await (prisma as any).$executeRaw`
    UPDATE web_test_data AS wtd
    SET 
      open_button_name   = mc.learned_rules->>'open_button',
      create_button_name = mc.primary_action_button
    FROM metadata_canonical mc
    WHERE wtd.project_id  = mc.project_id
      AND LOWER(wtd.entity_name) = LOWER(mc.entity_name)
      AND mc.project_id = ${projectId}::uuid
  `
  log.info('[REBUILD] Updated web_test_data button names from canonical')

  // 8. Summary
  const summary = await prisma.$queryRaw<Array<{
    entity_name: string
    req_fields: number
    opt_fields: number
    total_fields: number
    open_btn: string
    submit_btn: string
    relationships: string
  }>>`
    SELECT 
      entity_name,
      jsonb_array_length(COALESCE(required_fields,'[]')) AS req_fields,
      jsonb_array_length(COALESCE(optional_fields,'[]')) AS opt_fields,
      jsonb_array_length(COALESCE(form_fields,'[]')) AS total_fields,
      learned_rules->>'open_button' AS open_btn,
      primary_action_button AS submit_btn,
      relationships::text AS relationships
    FROM metadata_canonical
    WHERE project_id = ${projectId}::uuid
    ORDER BY entity_name
  `

  log.info('\n[REBUILD] ═══ FINAL CANONICAL STATE ═══')
  for (const row of summary) {
    log.info(
      `  ${row.entity_name.padEnd(12)} fields=${row.total_fields} ` +
      `(${row.req_fields} req + ${row.opt_fields} opt) ` +
      `open="${row.open_btn}" submit="${row.submit_btn}" ` +
      `rels=${row.relationships?.slice(0, 60)}`,
    )
  }

  log.info('[REBUILD] ✅ Complete')
}

async function main() {
  const projectId = process.argv[2]
  if (projectId) {
    await rebuildCanonical(projectId)
  } else {
    const rows = await prisma.project_integrations.findMany({
      where: { category: 'web_app' }, select: { project_id: true },
    })
    for (const { project_id } of rows) await rebuildCanonical(project_id)
  }
  await prisma.$disconnect()
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
