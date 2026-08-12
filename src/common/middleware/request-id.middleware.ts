import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Accepts an inbound correlation id or mints one. Every log line, error body
 * and upstream call carries it, so one customer complaint maps to one trace.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-ID', id);
    next();
  }
}
