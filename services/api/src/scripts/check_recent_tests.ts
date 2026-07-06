import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Querying recent test cases from database...')
  const testCases = await prisma.test_cases.findMany({
    orderBy: { updated_at: 'desc' },
    take: 10,
    select: {
      id: true,
      name: true,
      description: true,
      project_id: true,
      steps: true,
      created_at: true,
      updated_at: true,
    }
  })

  for (const tc of testCases) {
    console.log('====================================')
    console.log(`ID: ${tc.id}`)
    console.log(`Name: ${tc.name}`)
    console.log(`Description: ${tc.description}`)
    console.log(`Project ID: ${tc.project_id}`)
    console.log(`Created At: ${tc.created_at}`)
    console.log(`Updated At: ${tc.updated_at}`)
    const stepsCount = Array.isArray(tc.steps) ? tc.steps.length : (tc.steps ? 'non-array' : 0)
    console.log(`Steps Count: ${stepsCount}`)
    console.log(`Steps:`, JSON.stringify(tc.steps, null, 2))
  }
}

main()
  .catch(err => console.error(err))
  .finally(() => prisma.$disconnect())
