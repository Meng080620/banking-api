import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../modules/auth/jwt.strategy';

/**
 * Pulls the JWT-derived user off the request. Handlers take the caller's id as
 * a parameter instead of reaching into `req`, which keeps them unit-testable
 * without faking an HTTP request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    // JwtAuthGuard runs first, so this is always populated on guarded routes.
    return request.user as AuthenticatedUser;
  },
);
