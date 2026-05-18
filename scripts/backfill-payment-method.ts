import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { status: 'paid', paymentMethod: null },
    include: { linkedSale: true },
  });

  console.log(`Found ${invoices.length} paid invoices with null paymentMethod`);

  let updated = 0;
  for (const inv of invoices) {
    const meta = inv.linkedSale?.metadata as Record<string, unknown> | null;
    let method: string | null = null;

    if (meta?.paymentMethod && typeof meta.paymentMethod === 'string') {
      method = meta.paymentMethod;
    } else if (meta?.paymentReference && typeof meta.paymentReference === 'string') {
      // paymentReference was used in older versions before paymentMethod column existed
      method = meta.paymentReference;
    }

    const validMethods = ['cash','bank_transfer','pos','card','mobile_money','cheque','online','other'] as const;
    const fuzzyMap: Record<string, string> = {
      'bank transfer': 'bank_transfer',
      'bank-transfer': 'bank_transfer',
      'bank_transfer': 'bank_transfer',
    };

    if (method) {
      const normalized = method.toLowerCase().trim();
      let resolved = fuzzyMap[normalized] ?? (validMethods.includes(normalized as any) ? normalized : null);

      // If no exact or fuzzy match but the metadata has a reference that looks like a method
      if (!resolved && meta?.paymentReference) {
        const ref = String(meta.paymentReference).toLowerCase().trim();
        if (ref.includes('bank') || ref.includes('transfer')) resolved = 'bank_transfer';
        else if (ref.includes('pos')) resolved = 'pos';
        else if (ref.includes('cash')) resolved = 'cash';
        else if (ref.includes('card')) resolved = 'card';
        else if (ref.includes('mobile') || ref.includes('money')) resolved = 'mobile_money';
        else if (ref.includes('cheque') || ref.includes('check')) resolved = 'cheque';
        else if (ref.includes('online')) resolved = 'online';
      }

      if (resolved && validMethods.includes(resolved as any)) {
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { paymentMethod: resolved as any },
        });
        console.log(`  ✅ ${inv.invoiceNumber}: set paymentMethod = ${resolved}`);
        updated++;
      } else {
        console.log(`  ⏭️  ${inv.invoiceNumber}: unrecognized method "${method}"`);
      }
    } else {
      console.log(`  ⏭️  ${inv.invoiceNumber}: no metadata found`);
    }
  }

  console.log(`\nDone. Updated ${updated} invoice(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
