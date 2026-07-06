import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../shared/auth/jwt.js'

const prisma = new PrismaClient()

async function main() {
  const hashedPassword = await hashPassword('admin123')
  const user = await prisma.users.update({
    where: { username: 'admin' },
    data: { hashed_password: hashedPassword }
  })
  console.log(`Successfully updated admin password. User ID: ${user.id}`)
}

main()
  .catch(err => console.error(err))
  .finally(() => prisma.$disconnect())
