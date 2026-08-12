import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  const contextFor = (user: unknown): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const guardWithRequired = (required: string[] | undefined) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
    return new RolesGuard(reflector);
  };

  it('allows a route with no @Roles metadata', () => {
    expect(
      guardWithRequired(undefined).canActivate(contextFor(undefined)),
    ).toBe(true);
  });

  it('allows a user holding the required role', () => {
    expect(
      guardWithRequired(['admin']).canActivate(contextFor({ role: 'admin' })),
    ).toBe(true);
  });

  it('rejects a user holding a different role', () => {
    expect(() =>
      guardWithRequired(['admin']).canActivate(
        contextFor({ role: 'customer' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request rather than defaulting to allow', () => {
    // The dangerous failure mode: no user on the request must never pass.
    expect(() =>
      guardWithRequired(['admin']).canActivate(contextFor(undefined)),
    ).toThrow(ForbiddenException);
  });
});
