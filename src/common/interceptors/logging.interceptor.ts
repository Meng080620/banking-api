import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const started = Date.now();

    return next.handle().pipe(
      tap(() => {
        // Failures are logged by AllExceptionsFilter, so this path is success only.
        this.logger.log(
          JSON.stringify({
            requestId: req.requestId,
            method: req.method,
            path: req.url,
            durationMs: Date.now() - started,
            status: 'SUCCESS',
          }),
        );
      }),
    );
  }
}
