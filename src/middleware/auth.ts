import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import { AppError } from '@/middleware/errorHandler';
import { AuthenticatedRequest, JWTPayload } from '@/types';

export const authenticate = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return next(new AppError(401, 'Authentication required', 'UNAUTHORIZED'));
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as JWTPayload;
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Token has expired', 'TOKEN_EXPIRED'));
    }
    return next(new AppError(401, 'Invalid token', 'UNAUTHORIZED'));
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Forbidden: insufficient permissions', 'FORBIDDEN'));
    }
    next();
  };
};