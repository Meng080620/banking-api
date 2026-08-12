import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/** Shape @nestjs/terminus returns from a failing health check. */
function isHealthCheckResult(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'status' in payload &&
    'details' in payload
  );
}

/** The single error envelope every client parses. */
interface ErrorBody {
  code: string;
  message: string;
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'DUPLICATE_REQUEST',
  422: 'UNPROCESSABLE',
};

/**
 * Every error leaves through here in one shape. Internal failures are logged
 * with their stack but answered with a generic message — stack traces and ORM
 * errors must never reach a banking client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.requestId;

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload = isHttp ? exception.getResponse() : null;

    // Terminus health results carry their own diagnostic shape
    // ({ status, info, error, details }). Flattening that into our envelope
    // tells whoever is on call "internal server error" when the real answer is
    // "redis is down" — so it passes through untouched.
    if (isHealthCheckResult(payload)) {
      this.logger.warn(JSON.stringify({ requestId, status, path: req.url }));
      res.status(status).json(payload);
      return;
    }

    const body =
      typeof payload === 'object' && payload !== null
        ? (payload as Partial<ErrorBody>)
        : null;

    const code = body?.code ?? DEFAULT_CODES[status] ?? 'INTERNAL_ERROR';
    const message =
      body?.message ??
      (status >= 500 ? 'Internal server error' : 'Request failed');

    this.logger.error(
      JSON.stringify({ requestId, status, code, path: req.url }),
      exception instanceof Error ? exception.stack : undefined,
    );

    res
      .status(status)
      .json({ success: false, error: { code, message }, requestId });
  }
}
