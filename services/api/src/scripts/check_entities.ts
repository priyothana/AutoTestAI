import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const projectId = '5006cc44-0e03-45bd-8a84-3b2582f84b02'
  const rows = await prisma.metadata_canonical.findMany({
    where: { project_id: projectId },
    select: {
      entity_name: true,
      entity_type: true,
      page_url: true,
      primary_action_button: true,
      form_fields: true,
      required_fields: true
    }
  })

  console.log(`Found ${rows.length} canonical records:`)
  for (const r of rows) {
    console.log(`\n- Entity: ${r.entity_name} (${r.entity_type})`)
    console.log(`  URL: ${r.page_url}`)
    console.log(`  Button: ${r.primary_action_button}`)
    console.log(`  Fields:`, JSON.stringify(r.form_fields)?.slice(0, 150))
    console.log(`  Required:`, JSON.stringify(r.required_fields)?.slice(0, 150))
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
