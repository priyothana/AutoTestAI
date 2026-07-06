import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const projectId = 'f42c4395-9993-4d13-833e-dc2f7518245c'
  console.log(`--- Fetching project info for ${projectId} ---`)

  const project = await prisma.projects.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      category: true,
      description: true,
      type: true,
      brd_filename: true,
      brd_content: true
    }
  })

  console.log({
    id: project?.id,
    name: project?.name,
    category: project?.category,
    description: project?.description,
    type: project?.type,
    brd_filename: project?.brd_filename,
    has_brd_content: !!project?.brd_content,
    brd_content_length: project?.brd_content?.length ?? 0
  })

  if (project?.brd_content) {
    console.log('\n--- BRD Content Snippet (first 1000 chars):')
    console.log(project.brd_content.slice(0, 1000))
  }
}

main()
  .catch(err => console.error(err))
  .finally(() => prisma.$disconnect())
