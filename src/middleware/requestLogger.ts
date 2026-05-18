/**
 * HTTP Request Logger Middleware
 * 
 * Logs all incoming HTTP requests using Morgan.
 * Different formats for development and production.
 * 
 * @author WallX Engineering Team
 */

import morgan from 'morgan';
import logger from '@/lib/logger';
import config from '@/config';

/**
 * Custom Morgan token for response time in ms
 */
morgan.token('response-time-ms', (req, res) => {
  const responseTime = res.getHeader('X-Response-Time');
  return responseTime ? `${responseTime}ms` : '-';
});

/**
 * Create a stream object that writes to Winston
 */
const stream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};

/**
 * Development format - colorized and detailed
 */
const devFormat = ':method :url :status :response-time ms - :res[content-length]';

/**
 * Production format - JSON for log aggregation
 */
const prodFormat = ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';

/**
 * Request logger middleware
 */
export const requestLogger = morgan(
  config.app.isDevelopment ? devFormat : prodFormat,
  { stream }
);
