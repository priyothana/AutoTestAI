import { buildFieldManifest } from '../modules/ai-agents/tools/metadata-reader.tool.js'

async function main() {
  const manifest = await buildFieldManifest('5006cc44-0e03-45bd-8a84-3b2582f84b02', 'Booking')
  if (!manifest) {
    console.log('MANIFEST IS NULL — no fields loaded for Booking!')
  } else {
    console.log('Manifest entity:', manifest.entityName)
    console.log('Required count:', manifest.requiredCount)
    console.log('Source fields:')
    manifest.fields.forEach((f: any) => console.log(' -', f.label, '(' + f.type + ')', f.required ? '★' : ''))
    console.log('Submit button:', manifest.submitButton)
    console.log('Open button:', manifest.openButton)
  }
  process.exit(0)
}
main().catch((err: any) => { console.error(err); process.exit(1) })
