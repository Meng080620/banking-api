import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness: is the process up? A failure here means "restart me". */
  @Get('live')
  @ApiOperation({ summary: 'Liveness — a failure means restart the process' })
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: are my dependencies up? A failure means "stop routing traffic
   * to me" — but do NOT restart, the process itself is fine.
   *
   * Redis is included because a transfer whose notification cannot be queued
   * is a degraded service; reporting ready with Redis down keeps a load
   * balancer feeding an instance that silently drops every notification.
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness — checks Postgres and Redis' })
  @ApiResponse({ status: 200, description: 'All dependencies reachable' })
  @ApiResponse({ status: 503, description: 'A dependency is down' })
  ready() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
