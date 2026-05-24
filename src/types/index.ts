/**
 * Shared TypeScript Type Definitions
 *
 * @author WallX Engineering Team
 */

import { Request } from 'express';

/**
 * Authenticated user payload from JWT
 */
export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Params type with string values (not string | string[])
 */
export interface AppParams {
  [key: string]: string;
}

/**
 * Extended Express Request with authenticated user and properly typed params
 */
export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
  params: AppParams;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * API success response
 */
export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
