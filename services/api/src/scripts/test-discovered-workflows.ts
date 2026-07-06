import { PrismaClient } from '@prisma/client'
import { saveDiscoveredWorkflows, getDiscoveredWorkflows } from '../modules/project/project.service.js'

const prisma = new PrismaClient()

async function main() {
  console.log('Testing discovered workflows database persistence...')
  
  // 1. Find a project
  let project = await prisma.projects.findFirst()
  if (!project) {
    console.log('No project found, creating a dummy project...')
    project = await prisma.projects.create({
      data: {
        name: 'Workflow Test Project',
        type: 'webapp',
        category: 'webapp',
        status: 'Active',
      }
    })
  }
  
  console.log(`Using project ID: ${project.id}`)
  
  // 2. Clear any existing workflows to start fresh
  await prisma.discovered_workflows.deleteMany({
    where: { project_id: project.id }
  })
  
  // 3. Save test workflows
  const testFlows = [
    { name: 'E2E Checkout Flow', description: 'Tests user cart checkout and payment integration.' },
    { name: 'User Profile Setup', description: 'Tests avatar upload and setting updates.' }
  ]
  
  console.log('Saving workflows...')
  const saved = await saveDiscoveredWorkflows(project.id, testFlows, 'ai_discovery')
  console.log(`Saved workflows count: ${saved.length}`)
  
  if (saved.length !== 2) {
    throw new Error(`Expected 2 saved workflows, got ${saved.length}`)
  }
  
  console.log('Checking saved details:')
  for (const item of saved) {
    console.log(`- Title: ${item.workflow_title}, Description: ${item.description}, Discovered At: ${item.discovered_at}`)
  }
  
  // 4. Retrieve saved workflows
  console.log('Retrieving workflows...')
  const retrieved = await getDiscoveredWorkflows(project.id)
  console.log(`Retrieved workflows count: ${retrieved.length}`)
  
  if (retrieved.length !== 2) {
    throw new Error(`Expected 2 retrieved workflows, got ${retrieved.length}`)
  }
  
  console.log('Verification successful!')
}

main()
  .catch((err) => {
    console.error('Test failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
