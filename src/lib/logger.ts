/**
 * Winston Logger Configuration
 * 
 * Structured logging with different transports for development and production.
 * - Development: Console with colors
 * - Production: JSON format for log aggregation tools
 * 
 * @author WallX Engineering Team
 */

import winston from 'winston';
import config from '@/config';

/**
 * Custom log format for development (readable)
 */
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaString}`;
  })
);

/**
 * JSON format for production (machine-readable)
 */
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Create Winston logger instance
 */
const logger = winston.createLogger({
  level: config.monitoring.logLevel,
  format: config.app.isProduction ? prodFormat : devFormat,
  defaultMeta: {
    service: 'paymytax-api',
    environment: config.app.env,
  },
  transports: [
    // Console transport
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),

    // File transports (production only)
    ...(config.app.isProduction
      ? [
          new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
        ]
      : []),
  ],
});

/**
 * Create a child logger with additional context
 */
export const createChildLogger = (context: Record<string, any>) => {
  return logger.child(context);
};

export default logger;
