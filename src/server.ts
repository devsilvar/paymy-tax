/**
 * Server Entry Point
 * 
 * Starts the Express server and handles graceful shutdown.
 * 
 * @author WallX Engineering Team
 */

import { createApp } from './app';
import config from './config';
import logger from './lib/logger';
import prisma from './lib/prisma';
import { registerReminderCron } from './jobs/reminders.cron';

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // Create Express app
    const app = createApp();

    // Start listening — bind to 0.0.0.0 explicitly so the platform's
    // port scanner (Render, Fly, Docker) can reach us. Defaulting to
    // localhost on some Node configs makes the port invisible externally.
    const server = app.listen(config.app.port, '0.0.0.0', () => {
      logger.info('=================================');
      logger.info('🚀 PayMyTax API Server Started');
      logger.info('=================================');
      logger.info(`Environment: ${config.app.env}`);
      logger.info(`Port: ${config.app.port}`);
      logger.info(`API Version: ${config.app.apiVersion}`);
      logger.info(`Health Check: http://localhost:${config.app.port}/api/health`);
      logger.info('=================================');

      // Register scheduled jobs after the HTTP server is up. Wrapped so a
      // cron registration failure cannot crash the API.
      try {
        registerReminderCron();
      } catch (cronErr) {
        logger.error('❌ Failed to register reminder cron', {
          error: cronErr instanceof Error ? cronErr.message : String(cronErr),
        });
      }
    });

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
      logger.info(`\n${signal} received. Starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(async () => {
        logger.info('✅ HTTP server closed');

        // Close database connection
        try {
          await prisma.$disconnect();
          logger.info('✅ Database connection closed');
        } catch (error) {
          logger.error('❌ Error closing database connection', { error });
        }

        logger.info('👋 Shutdown complete. Goodbye!');
        process.exit(0);
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('❌ Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('❌ Uncaught Exception', { error: error.message, stack: error.stack });
      shutdown('UNCAUGHT_EXCEPTION');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled Rejection', { reason, promise });
      shutdown('UNHANDLED_REJECTION');
    });

  } catch (error) {
    logger.error('❌ Failed to start server', { error });
    process.exit(1);
  }
};

// Start the server
startServer();
