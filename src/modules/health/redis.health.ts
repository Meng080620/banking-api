import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { NOTIFICATIONS_QUEUE } from '../notifications/notifications.constants';

/** A health check that can hang is worse than one that fails. */
const PING_TIMEOUT_MS = 2000;

/**
 * Pings Redis through the queue's own connection rather than opening a second
 * client — so this reports on the exact connection background jobs depend on,
 * not on a lookalike that happens to be healthy.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    try {
      // waitUntilReady proves the connection is established; getWaitingCount
      // then issues a real command, so a half-open socket is caught too.
      // Both are bounded: ioredis queues commands while offline rather than
      // rejecting, so an unbounded probe would hang instead of failing.
      await withTimeout(
        this.queue.waitUntilReady().then(() => this.queue.getWaitingCount()),
        PING_TIMEOUT_MS,
      );
      return indicator.up();
    } catch (err: unknown) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'redis unreachable',
      });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}
