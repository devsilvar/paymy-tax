import prisma from '../src/lib/prisma';

async function main() {
  const all = await prisma.invoice.findMany({
    select: { id: true, invoiceNumber: true, status: true, dueDate: true, businessId: true, customerName: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log(`Latest ${all.length} invoices:`);
  for (const i of all) console.log(JSON.stringify(i));
  await prisma.$disconnect();
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
