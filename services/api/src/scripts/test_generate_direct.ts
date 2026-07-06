import { PrismaClient } from '@prisma/client'
import { generateTest } from '../modules/test-generation/generation.service.js'

const prisma = new PrismaClient()

async function main() {
  console.log('Querying projects from database...')
  const projects = await prisma.projects.findMany({
    take: 5,
    select: { id: true, name: true, category: true }
  })
  console.log('Projects found:', projects)

  if (projects.length === 0) {
    console.error('No projects found in database!')
    return
  }

  // Use the first project
  const project = projects[0]
  console.log(`Running test generation for project: ${project.name} (${project.id})`)

  try {
    const result = await generateTest({
      prompt: "Create a new Opportunity for the account 'Tara' and verify the flow",
      provider: "openai",
      project_id: project.id
    })
    console.log('SUCCESS!')
    console.log('Result name:', result.name)
    console.log('Result description:', result.description)
    console.log('Steps count:', result.steps?.length)
    console.log('Steps:', JSON.stringify(result.steps, null, 2))
  } catch (error) {
    console.error('ERROR during generation:', error)
  }
}

main()
  .catch(err => console.error(err))
  .finally(() => prisma.$disconnect())
