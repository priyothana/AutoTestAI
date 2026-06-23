import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const projectId = '5006cc44-0e03-45bd-8a84-3b2582f84b02'
  
  const project = await prisma.projects.findUnique({
    where: { id: projectId }
  })
  console.log('Project:', {
    id: project?.id,
    name: project?.name,
    base_url: project?.base_url,
    updated_at: project?.updated_at
  })

  const integrations = await prisma.project_integrations.findMany({
    where: { project_id: projectId }
  })
  console.log('\nIntegrations:')
  for (const integration of integrations) {
    console.log({
      id: integration.id,
      category: integration.category,
      status: integration.status,
      last_synced_at: integration.last_synced_at,
      sync_error: integration.sync_error
    })
  }

  const rawCount = await prisma.metadata_raw_store.count({ where: { project_id: projectId } })
  const normCount = await prisma.metadata_normalized.count({ where: { project_id: projectId } })
  const domainModelCount = await prisma.domain_models.count({ where: { project_id: projectId } })
  const embedCount = await prisma.vector_embeddings.count({ where: { project_id: projectId } })
  const canonicalCount = await prisma.metadata_canonical.count({ where: { project_id: projectId } })

  console.log('\nStats:', {
    rawCount,
    normCount,
    domainModelCount,
    embedCount,
    canonicalCount
  })
}

main().catch(console.error).finally(() => prisma.$disconnect())
