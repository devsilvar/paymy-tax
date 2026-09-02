import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { encryptPii } from '../src/lib/encryption';

async function main() {
  console.log('Scanning for unencrypted PII in database...');

  // Select all users that have unencrypted BVN or NIN
  const users = await prisma.user.findMany({
    where: {
      OR: [
        {
          bvnEncrypted: {
            not: null,
          },
        },
        {
          ninEncrypted: {
            not: null,
          },
        },
      ],
    },
    select: {
      id: true,
      bvnEncrypted: true,
      ninEncrypted: true,
    },
  });

  let bvnEncryptedCount = 0;
  let ninEncryptedCount = 0;
  let alreadyEncryptedCount = 0;

  for (const user of users) {
    const dataToUpdate: { bvnEncrypted?: string; ninEncrypted?: string } = {};

    if (user.bvnEncrypted) {
      if (!user.bvnEncrypted.startsWith('v1.')) {
        dataToUpdate.bvnEncrypted = encryptPii(user.bvnEncrypted);
        bvnEncryptedCount++;
      } else {
        alreadyEncryptedCount++;
      }
    }

    if (user.ninEncrypted) {
      if (!user.ninEncrypted.startsWith('v1.')) {
        dataToUpdate.ninEncrypted = encryptPii(user.ninEncrypted);
        ninEncryptedCount++;
      }
    }

    if (Object.keys(dataToUpdate).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: dataToUpdate,
      });
    }
  }

  console.log('PII Encryption backfill completed:');
  console.log(`  - BVNs newly encrypted: ${bvnEncryptedCount}`);
  console.log(`  - NINs newly encrypted: ${ninEncryptedCount}`);
  console.log(`  - Already encrypted / skipped: ${alreadyEncryptedCount}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('PII Encryption backfill failed:', err);
  process.exit(1);
});
