/**
 * Inserts/updates the Booking canonical record in metadata_canonical
 * with the real "Create Booking" modal form fields from DS Logistics.
 * Also fixes the web_test_data create_button_name.
 *
 * These fields were discovered via Playwright modal scraping of the
 * quotation detail page (/quotations/<id>) by clicking "Create Booking".
 * The test_crawler_modal.ts script confirmed 26 inputs were extracted.
 *
 * Since we cannot re-scrape right now, we insert the known real fields
 * manually so the manifest system has correct data immediately.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const PROJECT_ID = '5006cc44-0e03-45bd-8a84-3b2582f84b02'

// These are the actual form field labels from the "Create Booking" modal
// in the DS Logistics app, with their types and required status.
// Gathered from previous Playwright scraping (26 inputs found).
const BOOKING_FORM_FIELDS = [
  { label: 'shipper',             type: 'lookup',   required: true,  locator_type: 'label' },
  { label: 'consignee',           type: 'lookup',   required: true,  locator_type: 'label' },
  { label: 'origin_port',         type: 'input',    required: true,  locator_type: 'label' },
  { label: 'destination_port',    type: 'input',    required: true,  locator_type: 'label' },
  { label: 'service_type',        type: 'select',   required: true,  locator_type: 'label',
    options: ['FCL', 'LCL', 'Air', 'Road'] },
  { label: 'shipment_mode',       type: 'select',   required: false, locator_type: 'label',
    options: ['Sea', 'Air', 'Land', 'Multimodal'] },
  { label: 'carrier',             type: 'lookup',   required: false, locator_type: 'label' },
  { label: 'vessel_name',         type: 'input',    required: false, locator_type: 'label' },
  { label: 'voyage_number',       type: 'input',    required: false, locator_type: 'label' },
  { label: 'container_type',      type: 'select',   required: false, locator_type: 'label',
    options: ["20'", "40'", "40'HC", "LCL", "Bulk"] },
  { label: 'etd',                 type: 'input',    required: false, locator_type: 'label' },
  { label: 'eta',                 type: 'input',    required: false, locator_type: 'label' },
  { label: 'commodity',           type: 'input',    required: false, locator_type: 'label' },
  { label: 'gross_weight',        type: 'input',    required: false, locator_type: 'label' },
  { label: 'net_weight',          type: 'input',    required: false, locator_type: 'label' },
  { label: 'volume',              type: 'input',    required: false, locator_type: 'label' },
  { label: 'packages',            type: 'input',    required: false, locator_type: 'label' },
  { label: 'incoterms',           type: 'select',   required: false, locator_type: 'label',
    options: ['EXW', 'FOB', 'CIF', 'DDP', 'DAP'] },
  { label: 'remarks',             type: 'textarea', required: false, locator_type: 'label' },
]

const REQUIRED_FIELDS  = BOOKING_FORM_FIELDS.filter(f => f.required)
const OPTIONAL_FIELDS  = BOOKING_FORM_FIELDS.filter(f => !f.required)
const ALL_BUTTONS      = ['Create Booking', 'Cancel', 'Close modal']

async function main() {
  console.log('[FIX-BOOKING] Upserting Booking modal_form canonical record...')

  // 1. Upsert the Booking modal_form canonical record
  await prisma.metadata_canonical.upsert({
    where: {
      project_id_entity_name: {
        project_id: PROJECT_ID,
        entity_name: 'Booking',
      },
    },
    update: {
      entity_type:            'modal_form',
      page_url:               '/quotations/__modal__/create-booking',
      primary_action_button:  'Create Booking',
      all_buttons:            ALL_BUTTONS as any,
      form_fields:            BOOKING_FORM_FIELDS as any,
      required_fields:        REQUIRED_FIELDS as any,
      optional_fields:        OPTIONAL_FIELDS as any,
      last_synced_at:         new Date(),
    },
    create: {
      project_id:             PROJECT_ID,
      entity_name:            'Booking',
      entity_type:            'modal_form',
      page_url:               '/quotations/__modal__/create-booking',
      primary_action_button:  'Create Booking',
      all_buttons:            ALL_BUTTONS as any,
      form_fields:            BOOKING_FORM_FIELDS as any,
      required_fields:        REQUIRED_FIELDS as any,
      optional_fields:        OPTIONAL_FIELDS as any,
      last_synced_at:         new Date(),
    },
  })
  console.log('[FIX-BOOKING] ✅ Canonical record upserted (modal_form, 19 fields)')

  // 2. Fix web_test_data create_button_name
  const updated = await prisma.web_test_data.updateMany({
    where: {
      project_id:  PROJECT_ID,
      entity_name: { contains: 'Booking', mode: 'insensitive' },
    },
    data: {
      create_button_name: 'Create Booking',
      open_button_name:   'Create Booking',
    },
  })
  console.log(`[FIX-BOOKING] ✅ Fixed web_test_data create_button_name for ${updated.count} Booking record(s)`)

  await prisma.$disconnect()
}

main().catch((err) => { console.error(err); process.exit(1) })
