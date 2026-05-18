/**
 * Health Check Routes
 * 
 * Simple endpoint to verify API is running.
 * Used by monitoring services and load balancers.
 * 
 * @author WallX Engineering Team
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import prisma from '@/lib/prisma';

const router = Router();

/**
 * GET /health
 * Basic health check
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'paymytax-api',
    version: '1.0.0',
  });
}));

/**
 * GET /health/detailed
 * Detailed health check with database connectivity
 */
router.get('/detailed', asyncHandler(async (req: Request, res: Response) => {
  // Check database connection
  let dbStatus = 'disconnected';
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch (error) {
    dbStatus = 'error';
  }

  const health = {
    status: dbStatus === 'connected' ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'paymytax-api',
    version: '1.0.0',
    checks: {
      database: dbStatus,
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB',
      },
    },
  };

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
}));

export default router;
