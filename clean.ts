import { prisma } from './db.config.js';

async function main() {
  const count = await prisma.$executeRaw`DELETE FROM TH_RIHRI WHERE RIHRI_TA = 'Emergencia'`;
  console.log(`Borrados: ${count}`);
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
