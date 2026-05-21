/**
 * Metadata Reader Tool — Entity Field Manifest Builder
 *
 * Extracted from test-case-generator.service.ts (buildEntityFieldManifest +
 * buildVerifiedUrlMap). Agents call this to get the exact field labels,
 * required status, locator types, and submit button names for any entity.
 *
 * This is the primary anti-hallucination tool — it gives agents the
 * ground truth from the crawler/metadata instead of letting the LLM guess.
 */
import prisma                 from '../../../shared/db/prisma.js'
import { createModuleLogger } from '../../../shared/logger/index.js'
import type { FieldManifest, FieldEntry, VerifiedUrlMap } from '../agent.types.js'

const log = createModuleLogger('metadata-reader-tool')

// ── Field manifest builder ────────────────────────────────────────────────────

/**
 * Build a structured field manifest for the given project.
 * Prioritises webapp_crawl metadata; falls back to Salesforce field rows.
 */
export async function buildFieldManifest(
  projectId:    string,
  entityFilter?: string,   // optional: scope to one entity name
): Promise<FieldManifest | null> {
  try {
    // ── Path A: webapp_crawl metadata (most apps) ────────────────────────────
    const webRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { object_name: true, structured_json: true },
      take:   30,
    })

    if (webRows.length > 0) {
      for (const row of webRows) {
        const data = (row.structured_json ?? {}) as {
          pages?: Array<{
            path?:       string
            inputs?:     Array<{ locator?: string; required?: boolean }>
            selects?:    Array<{ locator?: string; required?: boolean; options?: string[] }>
            buttons?:    Array<{ name?: string }>
          }>
        }

        for (const page of data.pages ?? []) {
          const entityName = entityFilter ?? row.object_name ?? 'Unknown'
          if (entityFilter && !page.path?.toLowerCase().includes(entityFilter.toLowerCase())) continue

          const fields: FieldEntry[] = []

          for (const inp of page.inputs ?? []) {
            if (!inp.locator) continue
            const isLookup = /\b(account|contact|owner|parent|manager|vendor|customer)\b/i.test(inp.locator)
            fields.push({
              label:       inp.locator,
              type:        isLookup ? 'lookup' : 'input',
              required:    inp.required ?? false,
              locatorType: 'label',
            })
          }

          for (const sel of page.selects ?? []) {
            if (!sel.locator) continue
            fields.push({
              label:       sel.locator,
              type:        'select',
              required:    sel.required ?? false,
              options:     sel.options ?? [],
              locatorType: 'label',
            })
          }

          if (fields.length === 0) continue

          const submitBtn = (page.buttons ?? []).find(b => {
            const n = String(b.name ?? '').toLowerCase()
            return n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add')
          })

          return {
            entityName,
            requiredCount: fields.filter(f => f.required).length,
            fields,
            submitButton:  submitBtn?.name,
            createUrl:     page.path,
          }
        }
      }
    }

    // ── Path B: Salesforce field rows ────────────────────────────────────────
    const sfRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'field' },
      select: { label: true, object_name: true, structured_json: true },
      orderBy: { object_name: 'asc' },
    })

    if (sfRows.length === 0) return null

    const filtered = entityFilter
      ? sfRows.filter(r => r.object_name?.toLowerCase().includes(entityFilter.toLowerCase()))
      : sfRows

    if (filtered.length === 0) return null

    const entityName = filtered[0].object_name ?? 'Unknown'
    const fields: FieldEntry[] = []

    for (const row of filtered) {
      const json = (row.structured_json ?? {}) as Record<string, unknown>
      const type  = String(json.type ?? 'string').toLowerCase()
      const req   = Boolean(json.required ?? (json.nillable === false))
      const label = (row.label ?? '').trim()
      if (!label) continue

      let fieldType: FieldEntry['type'] = 'input'
      if (type === 'reference') fieldType = 'lookup'
      else if (type === 'picklist' || type === 'multipicklist') fieldType = 'select'
      else if (type === 'boolean') fieldType = 'checkbox'
      else if (type === 'textarea') fieldType = 'textarea'

      fields.push({ label, type: fieldType, required: req, locatorType: 'label' })
    }

    return {
      entityName,
      requiredCount: fields.filter(f => f.required).length,
      fields,
    }
  } catch (err) {
    log.warn({ err, projectId }, '[META-TOOL] buildFieldManifest failed')
    return null
  }
}

// ── URL map builder ───────────────────────────────────────────────────────────

const SKIP_PATHS = /^(login|logout|signin|signout|signup|register|auth|callback|oauth|sso|api|static|assets|_next|favicon|\.well-known)/i

/**
 * Return all crawler-verified paths for the project.
 */
export async function buildUrlMap(projectId: string): Promise<VerifiedUrlMap> {
  try {
    const project = await prisma.projects.findUnique({
      where:  { id: projectId },
      select: { base_url: true },
    })
    let baseUrl = ''
    try { baseUrl = project?.base_url ? new URL(project.base_url).origin : '' } catch { /* */ }

    const webRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId, entity_type: 'webapp_crawl' },
      select: { structured_json: true },
    })

    const pathSet = new Set<string>()
    for (const row of webRows) {
      const data = (row.structured_json ?? {}) as { pages?: Array<{ path?: string }> }
      for (const page of data.pages ?? []) {
        const p = (page.path ?? '').trim()
        if (!p || p === '/' || SKIP_PATHS.test(p.replace(/^\//, ''))) continue
        pathSet.add(p.startsWith('/') ? p : `/${p}`)
      }
    }

    log.info({ projectId, baseUrl, pathCount: pathSet.size }, '[META-TOOL] URL map built')
    return { baseUrl, paths: [...pathSet].sort() }
  } catch (err) {
    log.warn({ err, projectId }, '[META-TOOL] buildUrlMap failed')
    return { baseUrl: '', paths: [] }
  }
}

/**
 * Format a FieldManifest as a human-readable string for LLM prompts.
 */
export function formatManifestForPrompt(manifest: FieldManifest): string {
  const lines: string[] = [
    `=== ENTITY FIELD MANIFEST: ${manifest.entityName} ===`,
    `Required fields: ${manifest.requiredCount}`,
    '',
  ]

  const required = manifest.fields.filter(f => f.required)
  const optional = manifest.fields.filter(f => !f.required)

  if (required.length > 0) {
    lines.push('🔥 REQUIRED (must fill ALL or form will reject):')
    for (const f of required) {
      const opts = f.options?.length ? ` [options: ${f.options.slice(0, 4).join(' | ')}]` : ''
      const sample = f.sampleValue ? ` → sample: "${f.sampleValue}"` : ''
      lines.push(`  ★ "${f.label}" (${f.type})${opts}${sample}`)
    }
  }

  if (optional.length > 0) {
    lines.push('\n✅ OPTIONAL:')
    for (const f of optional.slice(0, 8)) {
      lines.push(`  • "${f.label}" (${f.type})`)
    }
  }

  if (manifest.submitButton) {
    lines.push(`\n⚡ SUBMIT BUTTON: "${manifest.submitButton}" — copy EXACTLY into CLICK target`)
  }
  if (manifest.createUrl) {
    lines.push(`📄 CREATE URL: ${manifest.createUrl}`)
  }

  lines.push('=== END MANIFEST ===')
  return lines.join('\n')
}
