/**
 * Salesforce Embedding Generator
 *
 * Port of Python: backend/app/services/embedding_service.py
 *
 * Converts normalized metadata + domain models into vector embeddings using
 * OpenAI `text-embedding-3-small`. Incremental: skips source IDs that already
 * have embeddings. Uses batches of 20 (matches OpenAI recommended batch size).
 *
 * If OPENAI_API_KEY is missing, logs a warning and returns 0 — the pipeline
 * still completes (normalized + domain counts are correct). Embeddings are
 * generated on the next sync when the key is available.
 *
 * Called from: metadata-sync.worker.ts (stage 4 of 4)
 */
import { OpenAI } from 'openai'
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { RecursiveCharacterTextSplitter } from '../../shared/utils/text-splitter.js'

const log = createModuleLogger('sf-embeddings')

const EMBEDDING_MODEL = 'text-embedding-3-small'
const MAX_CHUNK_CHARS = 6000 // keep well under the 8191-token limit
const BATCH_SIZE      = 20

// ─── Text conversion helpers ──────────────────────────────────────────────────

function metadataToText(data: Record<string, unknown>, entityType: string, objectName: string): string {
  if (entityType === 'object') {
    const fields         = (Array.isArray(data['fields'])  ? data['fields']  : []) as Record<string, unknown>[]
    const vrs            = (Array.isArray(data['validation_rules']) ? data['validation_rules'] : []) as Record<string, unknown>[]
    const requiredFields = fields.filter((f) => f['required'])
    const picklistFields = fields.filter((f) => String(f['type'] ?? '').toLowerCase() === 'picklist')

    const lines: string[] = [
      `Salesforce Object: ${String(data['object'] ?? objectName)}`,
      `Label: ${String(data['label'] ?? '')}`,
      `Custom: ${String(data['custom'] ?? false)}`,
      `Operations: create=${data['createable']}, edit=${data['updateable']}, delete=${data['deletable']}`,
    ]

    if (fields.length > 0) {
      lines.push(`Total fields: ${fields.length}`)
      if (requiredFields.length > 0) {
        lines.push(`Required fields: ${requiredFields.map((f) => String(f['api'] ?? '')).join(', ')}`)
      }
      for (const pf of picklistFields) {
        const values = (
          Array.isArray(pf['picklistValues']) ? pf['picklistValues'] : []
        ) as Record<string, unknown>[]
        const activeValues = values.filter((v) => v['active']).slice(0, 10).map((v) => String(v['value'] ?? ''))
        lines.push(`Picklist ${String(pf['api'] ?? '')}: ${activeValues.join(', ')}`)
      }
      lines.push(
        'Fields: ' + fields.slice(0, 50)
          .map((f) => `${String(f['api'] ?? '')}(${String(f['type'] ?? '')})`)
          .join(', '),
      )
    }

    if (vrs.length > 0) {
      lines.push(`Validation Rules (${vrs.length}):`)
      for (const vr of vrs) {
        lines.push(`  - ${String(vr['name'] ?? '')}: ${String(vr['error_message'] ?? '')}`)
      }
    }

    return lines.join('\n')
  }

  if (entityType === 'flow') {
    return [
      `Salesforce Flow: ${String(data['api_name'] ?? objectName)}`,
      `Label: ${String(data['label'] ?? '')}`,
      `Process Type: ${String(data['process_type'] ?? '')}`,
      `Status: ${String(data['status'] ?? '')}`,
      'This flow automates a business process in Salesforce.',
    ].join('\n')
  }

  if (entityType === 'lwc') {
    return [
      `Lightning Web Component: ${String(data['developer_name'] ?? objectName)}`,
      `Label: ${String(data['label'] ?? '')}`,
      `Description: ${String(data['description'] ?? '')}`,
      'This is a UI component that can be tested for rendering and interaction.',
    ].join('\n')
  }

  return ''
}

function domainToText(entityName: string, actions: string[], rules: Record<string, unknown>[]): string {
  const lines: string[] = [
    `Domain Model: ${entityName}`,
    `Available actions: ${actions.join(', ')}`,
    `Testing rules (${rules.length}):`,
  ]
  for (const rule of rules.slice(0, 20)) {
    lines.push(`  - [${String(rule['type'] ?? '')}] ${String(rule['description'] ?? '')}`)
  }
  return lines.join('\n')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate embeddings for all normalized metadata + domain models.
 * Incremental: skips source IDs already present in vector_embeddings.
 * Returns count of new embeddings created.
 */
export async function generateEmbeddings(projectId: string): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    log.warn('[EMBEDDINGS] OPENAI_API_KEY not set — skipping embedding generation')
    return 0
  }

  log.info(`[EMBEDDINGS] Starting embedding generation for project ${projectId}`)

  const client = new OpenAI({ apiKey })

  // Get existing source IDs so we can skip already-embedded records
  const existingRows = await prisma.vector_embeddings.findMany({
    where:  { project_id: projectId },
    select: { source_id: true },
  })
  const existingSourceIds = new Set(existingRows.map((r) => r.source_id))

  // Build chunk list
  type Chunk = {
    sourceId:   string
    sourceType: string
    chunkType:  string
    text:       string
  }

  const chunks: Chunk[] = []
  
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: MAX_CHUNK_CHARS,
    chunkOverlap: 200,
  })

  // ── from metadata_normalized ────────────────────────────────────────────
  const normalizedRows = await prisma.metadata_normalized.findMany({
    where: { project_id: projectId },
  })

  for (const record of normalizedRows) {
    if (existingSourceIds.has(record.id)) continue

    const data = (record.structured_json ?? {}) as Record<string, unknown>

    if (record.entity_type === 'webapp_crawl') {
      // per-page chunking for web app crawl entries
      const pages   = (Array.isArray(data['pages']) ? data['pages'] : []) as Record<string, unknown>[]
      const baseUrl = String(data['base_url'] ?? '')

      if (pages.length === 0) {
        const baseText = `WebApp metadata for ${baseUrl}: 0 pages crawled`
        const splitText = textSplitter.splitText(baseText)
        for (const split of splitText) {
          chunks.push({
            sourceId:   record.id,
            sourceType: 'webapp_page',
            chunkType:  'webapp_metadata',
            text:       split,
          })
        }
      } else {
        for (const page of pages) {
          const path     = String(page['path']  ?? '/')
          const title    = String(page['title'] ?? '')
          const headings = (Array.isArray(page['headings']) ? page['headings'] : []) as string[]
          const buttons  = (Array.isArray(page['buttons'])  ? page['buttons']  : []) as Record<string, unknown>[]
          const inputs   = (Array.isArray(page['inputs'])   ? page['inputs']   : []) as Record<string, unknown>[]
          const selects  = (Array.isArray(page['selects'])  ? page['selects']  : []) as Record<string, unknown>[]
          const testids  = (Array.isArray(page['testids'])  ? page['testids']  : []) as string[]

          const reqInputs = inputs.filter((i) => i['required'])
          const optInputs = inputs.filter((i) => !i['required'])

          const lines: string[] = [`WebApp Page: ${path}`, `Base URL: ${baseUrl}`]
          if (title)            lines.push(`Title: ${title}`)
          if (headings.length)  lines.push(`Headings: ${headings.slice(0, 5).join(', ')}`)
          if (buttons.length)   lines.push(`Buttons: ${buttons.slice(0, 15).map((b) => String(b['name'] ?? b['locator'] ?? '')).join(', ')}`)
          if (reqInputs.length) lines.push(`Required fields: ${reqInputs.map((i) => String(i['name'] ?? i['locator'] ?? '')).join(', ')}`)
          if (optInputs.length) lines.push(`Optional fields: ${optInputs.slice(0, 15).map((i) => String(i['name'] ?? i['locator'] ?? '')).join(', ')}`)
          if (selects.length)   lines.push(`Dropdowns: ${selects.slice(0, 10).map((s) => String(s['name'] ?? s['locator'] ?? '')).join(', ')}`)
          if (testids.length)   lines.push(`Test IDs: ${testids.slice(0, 10).join(', ')}`)

          const chunkText = lines.join('\n').trim()
          if (chunkText) {
            const splitText = textSplitter.splitText(chunkText)
            for (const split of splitText) {
              chunks.push({
                sourceId:   record.id,
                sourceType: 'webapp_page',
                chunkType:  'webapp_metadata',
                text:       split,
              })
            }
          }
        }
      }
    } else {
      const text = metadataToText(data, record.entity_type, record.object_name)
      if (text) {
        const splitText = textSplitter.splitText(text)
        for (const split of splitText) {
          chunks.push({
            sourceId:   record.id,
            sourceType: record.entity_type,
            chunkType:  'metadata',
            text:       split,
          })
        }
      }
    }
  }

  // ── from domain_models ──────────────────────────────────────────────────
  const domainRows = await prisma.domain_models.findMany({
    where: { project_id: projectId },
  })

  for (const record of domainRows) {
    if (existingSourceIds.has(record.id)) continue
    const actions = (Array.isArray(record.actions)       ? record.actions       : []) as string[]
    const rules   = (Array.isArray(record.testing_rules) ? record.testing_rules : []) as Record<string, unknown>[]
    const text    = domainToText(record.entity_name, actions, rules)
    if (text) {
      const splitText = textSplitter.splitText(text)
      for (const split of splitText) {
        chunks.push({
          sourceId:   record.id,
          sourceType: 'domain_model',
          chunkType:  'metadata',
          text:       split,
        })
      }
    }
  }

  if (chunks.length === 0) {
    log.info(`[EMBEDDINGS] No new chunks to embed for project ${projectId}`)
    return 0
  }

  // ── Generate in batches ─────────────────────────────────────────────────
  let count = 0

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map((c) => c.text)

    try {
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
      })

      for (let j = 0; j < response.data.length; j++) {
        const chunk   = batch[j]
        const vector  = response.data[j].embedding

        await prisma.vector_embeddings.create({
          data: {
            project_id:       projectId,
            source_type:      chunk.sourceType,
            source_id:        chunk.sourceId,
            chunk_type:       chunk.chunkType,
            embedding_vector: vector as object,
            text_chunk:       chunk.text,
          },
        })
        count++
      }
    } catch (err) {
      log.error({ err }, `[EMBEDDINGS] Batch ${i / BATCH_SIZE + 1} failed — skipping batch`)
      // Continue with next batch — don't abort the whole pipeline for one bad batch
    }
  }

  log.info(`[EMBEDDINGS] Generated ${count} embeddings for project ${projectId}`)
  return count
}
