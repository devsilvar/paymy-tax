/**
 * Global Error Handler Middleware
 *
 * Centralized error handling for all routes.
 * Catches errors, logs them, and sends appropriate responses to clients.
 *
 * @author WallX Engineering Team
 */

import { Request, Response, NextFunction } from 'express';
import logger from '@/lib/logger';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';

/**
 * Custom Application Error class
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error response interface
 */
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
    stack?: string;
  };
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
  err: Error | AppError | ZodError | Prisma.PrismaClientKnownRequestError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Log the error
  logger.error('Error occurred', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  // Default error response
  let statusCode = 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected error occurred';
  let details: any = undefined;

  // Handle different error types
  if (err instanceof AppError) {
    // Custom application errors
    statusCode = err.statusCode;
    errorCode = err.code || errorCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    // Validation errors from Zod
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Invalid input data';
    details = err.issues.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
  } else if (err instanceof MulterError) {
    // File upload errors — surface a friendly message with the right status.
    statusCode = 400;
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        errorCode = 'FILE_TOO_LARGE';
        message = 'Uploaded file is too large. Maximum 5 MB.';
        break;
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        errorCode = 'UPLOAD_INVALID';
        message = 'Too many files or unexpected field name.';
        break;
      default:
        errorCode = 'UPLOAD_ERROR';
        message = err.message || 'File upload failed.';
    }
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Database errors from Prisma
    statusCode = 400;

    switch (err.code) {
      case 'P2002':
        errorCode = 'DUPLICATE_ENTRY';
        message = 'A record with this value already exists';
        details = { field: (err.meta?.target as string[])?.[0] };
        break;
      case 'P2025':
        errorCode = 'NOT_FOUND';
        message = 'Record not found';
        statusCode = 404;
        break;
      case 'P2003':
        errorCode = 'FOREIGN_KEY_CONSTRAINT';
        message = 'Referenced record does not exist';
        break;
      default:
        errorCode = 'DATABASE_ERROR';
        message = 'Database operation failed';
    }
  }

  // Build error response
  const errorResponse: ErrorResponse = {
    error: {
      code: errorCode,
      message,
      ...(details && { details }),
      // Include stack trace in development only
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  };

  // Send response
  res.status(statusCode).json(errorResponse);
};

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
};

/**
 * Async handler wrapper to catch promise rejections
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};