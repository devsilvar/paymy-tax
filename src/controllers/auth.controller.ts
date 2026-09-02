import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { AuthenticatedRequest } from '@/types';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateMeSchema,
  revealBvnSchema,
} from '@/validators/auth.validator';
import * as authService from '@/services/auth.service';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const input = registerSchema.parse(req.body);
  const result = await authService.register(input);

  res.status(201).json({
    success: true,
    data: result,
    message: 'User registered successfully',
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input, req.ip, req.get('user-agent'));

  res.status(200).json({
    success: true,
    data: result,
    message: 'Login successful',
  });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = refreshTokenSchema.parse(req.body);
  const result = await authService.refreshAccessToken(refreshToken);

  res.status(200).json({
    success: true,
    data: result,
    message: 'Token refreshed successfully',
  });
});

export const getMe = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await authService.getMe(req.user!.userId);

  res.status(200).json({
    success: true,
    data: user,
  });
});

export const updateMe = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = updateMeSchema.parse(req.body);
  const user = await authService.updateMe(req.user!.userId, input);

  res.status(200).json({
    success: true,
    data: user,
    message: 'Profile updated',
  });
});

export const changePassword = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const result = await authService.changePassword(
      req.user!.userId,
      currentPassword,
      newPassword
    );

    res.status(200).json({
      success: true,
      data: result,
      message: 'Password changed successfully',
    });
  }
);

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  const result = await authService.forgotPassword(email);

  res.status(200).json({
    success: true,
    data: result,
    message: result.message,
  });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);
  const result = await authService.resetPassword(token, newPassword);

  res.status(200).json({
    success: true,
    data: result,
    message: result.message,
  });
});

export const revealBvn = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const input = revealBvnSchema.parse(req.body);
  const bvn = await authService.revealBvn(
    req.user!.userId,
    input,
    req.ip,
    req.get('user-agent')
  );

  res.status(200).json({
    success: true,
    data: { bvn },
    message: 'BVN retrieved successfully',
  });
});
