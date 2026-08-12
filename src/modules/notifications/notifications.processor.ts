import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  NOTIFICATIONS_QUEUE,
  TransferCompletedJob,
} from './notifications.constants';

/**
 * Runs in the same process as the API today. When notification volume starts
 * competing with request latency, this class moves to its own deployment with
 * no code change — the queue is already the boundary.
 */
@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  async process(job: Job<TransferCompletedJob>): Promise<void> {
    // Throwing here is correct: BullMQ retries with the backoff set by the
    // producer, and a permanently failing job lands in the failed set.
    this.logger.log(
      JSON.stringify({
        job: job.name,
        transferId: job.data.transferId,
        attempt: job.attemptsMade + 1,
      }),
    );
    await Promise.resolve();
  }
}
