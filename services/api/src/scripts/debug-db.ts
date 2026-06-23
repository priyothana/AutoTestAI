import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const rows = await prisma.metadata_canonical.findMany()

  console.log(`Scanning ${rows.length} canonical records...`)
  let fixedCount = 0
  const keepAsIs = new Set(['status', 'address', 'process', 'access', 'success', 'business', 'class', 'analysis'])

  for (const r of rows) {
    const bizRules = (r.business_rules ?? {}) as any
    if (bizRules.list_url && typeof bizRules.list_url === 'string') {
      const urlLower = bizRules.list_url.toLowerCase().trim()
      if (urlLower.endsWith('ss')) {
        const lastWord = urlLower.split('/').pop() ?? ''
        if (keepAsIs.has(lastWord)) {
          console.log(`- Skipping legitimate 'ss' URL: ${bizRules.list_url} (entity: ${r.entity_name})`)
          continue
        }
        const updatedUrl = bizRules.list_url.slice(0, -1)
        const updatedRules = { ...bizRules, list_url: updatedUrl }
        await prisma.metadata_canonical.update({
          where: { id: r.id },
          data: { business_rules: updatedRules }
        })
        console.log(`- Entity: ${r.entity_name}, fixed list_url from ${bizRules.list_url} to ${updatedUrl}`)
        fixedCount++
      }
    }
  }
  console.log(`Done. Fixed ${fixedCount} records.`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
