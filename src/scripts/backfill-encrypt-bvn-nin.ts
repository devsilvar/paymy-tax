import prisma from '@/lib/prisma';
import logger from '@/lib/logger';
import { encrypt, computeBlindIndex } from '@/lib/crypto';

/**
 * Backfill script: encrypts legacy unencrypted BVNs and NINs
 * and computes deterministic blind indexes for all existing users.
 *
 * Safe to run multiple times (idempotent).
 */
export async function backfillEncryptBvnNin(): Promise<{
  totalUsers: number;
  bvnEncrypted: number;
  ninEncrypted: number;
}> {
  logger.info('Starting BVN/NIN encryption backfill...');

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { bvn: { not: null } },
        { nin: { not: null } },
      ],
    },
    select: {
      id: true,
      bvn: true,
      bvnHash: true,
      nin: true,
      ninHash: true,
    },
  });

  let bvnEncrypted = 0;
  let ninEncrypted = 0;

  for (const user of users) {
    const updates: Record<string, any> = {};

    // Check if BVN needs encryption or hash
    if (user.bvn && !user.bvn.startsWith('enc:v1:')) {
      updates.bvn = encrypt(user.bvn);
      updates.bvnHash = computeBlindIndex(user.bvn);
      bvnEncrypted++;
    } else if (user.bvn && !user.bvnHash) {
      // BVN already encrypted but missing blind index
      // Decrypt legacy or ciphertext to compute index
      const { decrypt } = await import('@/lib/crypto');
      const plain = decrypt(user.bvn);
      if (plain) {
        updates.bvnHash = computeBlindIndex(plain);
      }
    }

    // Check if NIN needs encryption or hash
    if (user.nin && !user.nin.startsWith('enc:v1:')) {
      updates.nin = encrypt(user.nin);
      updates.ninHash = computeBlindIndex(user.nin);
      ninEncrypted++;
    } else if (user.nin && !user.ninHash) {
      const { decrypt } = await import('@/lib/crypto');
      const plain = decrypt(user.nin);
      if (plain) {
        updates.ninHash = computeBlindIndex(plain);
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updates,
      });
    }
  }

  logger.info('BVN/NIN encryption backfill completed', {
    totalUsers: users.length,
    bvnEncrypted,
    ninEncrypted,
  });

  return {
    totalUsers: users.length,
    bvnEncrypted,
    ninEncrypted,
  };
}

if (require.main === module) {
  backfillEncryptBvnNin()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Backfill failed', { error: err.message });
      process.exit(1);
    });
}
