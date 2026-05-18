/**
 * Express Application Setup
 * 
 * Configures the Express app with all middleware, routes, and error handlers.
 * This file is separate from server.ts for easier testing.
 * 
 * @author WallX Engineering Team
 */

import express, { Application } from 'express';
import swaggerUi from 'swagger-ui-express';
import config from '@/config';
import logger from '@/lib/logger';
import { requestLogger } from '@/middleware/requestLogger';
import {
  helmetMiddleware,
  corsMiddleware,
  globalRateLimiter
} from '@/middleware/security';
import { errorHandler, notFoundHandler } from '@/middleware/errorHandler';
import routes from '@/routes';
import { swaggerSpec } from '@/config/swagger';

/**
 * Create and configure Express application
 */
export const createApp = (): Application => {
  const app = express();

  // =================================
  // SECURITY MIDDLEWARE
  // =================================
  app.use(helmetMiddleware);
  app.use(corsMiddleware);

  // =================================
  // BODY PARSING MIDDLEWARE
  // =================================
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString();
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // =================================
  // REQUEST LOGGING
  // =================================
  app.use(requestLogger);

  // =================================
  // RATE LIMITING
  // =================================
  if (config.app.isProduction) {
    app.use('/api', globalRateLimiter);
  }

  // =================================
  // TRUST PROXY (for deployment behind reverse proxy)
  // =================================
  if (config.app.isProduction) {
    app.set('trust proxy', 1);
  }

  // =================================
  // SWAGGER DOCUMENTATION
  // =================================
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'PayMyTax API Docs',
  }));
  
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  // =================================
  // API ROUTES
  // =================================
  app.use('/api', routes);

  // Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({
      service: 'PayMyTax API by WallX',
      version: '1.0.0',
      status: 'running',
      environment: config.app.env,
      documentation: '/api-docs',
      health: '/api/health',
    });
  });

  // =================================
  // ERROR HANDLING
  // =================================
  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info('✅ Express application configured successfully');

  return app;
};

export default createApp;
