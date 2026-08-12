/**
 * Teaches TypeScript about the two things attached to every request: the
 * correlation id from RequestIdMiddleware, and the user Passport puts there.
 * Without this, consumers fall back to `(req as any)` and a `req.userId` typo
 * survives all the way to production.
 *
 * `User` is merged into Passport's own `Express.User` rather than redeclared
 * on Request — redeclaring conflicts with @types/passport.
 */
declare global {
  namespace Express {
    interface User {
      userId: string;
      role: string;
    }

    interface Request {
      requestId: string;
    }
  }
}

export {};
