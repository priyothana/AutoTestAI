import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const projectId = '5006cc44-0e03-45bd-8a84-3b2582f84b02';
  const raw = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' }
  });
  
  if (!raw) {
    console.log("No raw webpage metadata found for DS Logistics!");
    return;
  }
  
  const rawJson = raw.raw_json || {};
  const pages = rawJson.pages || [];
  
  const quotationPages = pages.filter(p => p.url && p.url.includes('/quotations/'));
  console.log(`Found ${quotationPages.length} Quotation Details pages:`);
  
  for (const p of quotationPages) {
    console.log(`\nURL: ${p.url}`);
    console.log(`Title: ${p.title}`);
    console.log(`Buttons count: ${p.buttons ? p.buttons.length : 0}`);
    if (p.buttons) {
      console.log('Buttons:', p.buttons.map(b => b.name));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
