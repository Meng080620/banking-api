import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { NotificationsModule } from '../notifications/notifications.module';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

@Module({
  // NotificationsModule re-exports the BullMQ queue, so the readiness check
  // pings the same Redis connection the workers actually use.
  imports: [TerminusModule, NotificationsModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
