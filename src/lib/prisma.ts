/**
 * Prisma Client Singleton
 * 
 * Ensures only one instance of PrismaClient is created.
 * Prevents connection pool exhaustion in development with hot reloading.
 * 
 * @author WallX Engineering Team
 */

import { PrismaClient, Prisma } from '@prisma/client';
import logger from './logger';

/**
 * Transaction-aware Prisma client type.
 *
 * Use this as the parameter type in any service function that needs
 * to run inside a transaction.  Callers either pass the `tx` they
 * received from `prisma.$transaction()`, or omit it to use the
 * global singleton — both satisfy this type.
 */
export type TxClient = Prisma.TransactionClient;

/**
 * PrismaClient with query logging in development
 */
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn']
      : ['error'],
  });
};

// Declare global type for Prisma
declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

// Create or reuse existing instance
const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

// Store in global for development hot reload
if (process.env.NODE_ENV !== 'production') {
  globalThis.prismaGlobal = prisma;
}

// Only attempt connection if not in test mode
if (process.env.NODE_ENV !== 'test') {
  prisma.$connect()
    .then(() => {
      logger.info('✅ Database connected successfully');
    })
    .catch((error) => {
      logger.error('❌ Database connection failed', { error: error.message });
      logger.warn('⚠️  Set up your database and update DATABASE_URL in .env');
      // Don't exit in development to allow testing without DB
      if (process.env.NODE_ENV === 'production') {
        process.exit(1);
      }
    });
}

export default prisma;
