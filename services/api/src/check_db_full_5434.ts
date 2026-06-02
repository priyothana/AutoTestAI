import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:postgres@localhost:5434/autotestdb',
    },
  },
});

async function main() {
  console.log('--- SCANNING DOCKER POSTGRES (PORT 5434) ---');

  // 1. projects
  const projects = await prisma.projects.findMany({
    where: { base_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`Projects matching crmd.datasirpi.com:`, projects.map(p => ({ id: p.id, name: p.name, base_url: p.base_url })));

  // 2. project_integrations
  const integrations = await prisma.project_integrations.findMany({
    where: { base_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`Integrations matching crmd.datasirpi.com:`, integrations.map(i => ({ id: i.id, project_id: i.project_id, base_url: i.base_url })));

  // 3. environments
  const envs = await prisma.environments.findMany({
    where: { base_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`Environments matching crmd.datasirpi.com:`, envs.map(e => ({ id: e.id, name: e.name, base_url: e.base_url })));

  // 4. app_settings
  const settings = await prisma.app_settings.findMany({
    where: { base_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`AppSettings matching crmd.datasirpi.com:`, settings.map(s => ({ id: s.id, base_url: s.base_url })));

  // 5. web_test_data
  const webTestData = await prisma.web_test_data.findMany({
    where: { source_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`WebTestData matching crmd.datasirpi.com:`, webTestData.map(w => ({ id: w.id, entity_name: w.entity_name, source_url: w.source_url })));

  // 6. selector_registry
  const selectors = await prisma.selector_registry.findMany({
    where: { page_url: { contains: 'crmd.datasirpi.com' } }
  });
  console.log(`SelectorRegistry matching crmd.datasirpi.com:`, selectors.map(s => ({ id: s.id, field_name: s.field_name, page_url: s.page_url })));
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
