import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const dsLogisticsProjId = '5006cc44-0e03-45bd-8a84-3b2582f84b02';
  const raw = await prisma.metadata_raw_store.findFirst({
    where: { project_id: dsLogisticsProjId, metadata_type: 'webpage' }
  });
  
  if (!raw) {
    console.log("No raw webpage metadata found for DS Logistics!");
    return;
  }
  
  const rawJson = raw.raw_json || {};
  const pages = rawJson.pages || [];
  const modals = pages.filter(p => p.is_modal || p.source === 'modal' || p.source === 'popup' || (p.path && p.path.includes('__modal__')));
  
  console.log(`Found ${modals.length} modals in DS Logistics:`);
  for (const m of modals) {
    console.log(`\n===========================================`);
    console.log(`URL: ${m.url}`);
    console.log(`Trigger Button: ${m.modal_trigger_button}`);
    console.log(`Headings:`, m.headings);
    
    console.log(`\n--- INPUTS (${m.inputs ? m.inputs.length : 0}) ---`);
    m.inputs?.forEach(i => console.log(`  - name="${i.name}" tag="${i.tag}" required=${i.required} locator="${i.locator}"`));
    
    console.log(`\n--- SELECTS (${m.selects ? m.selects.length : 0}) ---`);
    m.selects?.forEach(s => console.log(`  - name="${s.name}" required=${s.required} options=${JSON.stringify(s.options)}`));
    
    console.log(`\n--- BUTTONS (${m.buttons ? m.buttons.length : 0}) ---`);
    m.buttons?.forEach(b => console.log(`  - name="${b.name}" locator="${b.locator}"`));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
