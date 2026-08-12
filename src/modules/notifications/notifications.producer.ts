import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  NOTIFICATIONS_QUEUE,
  TRANSFER_COMPLETED_JOB,
  TransferCompletedJob,
} from './notifications.constants';

@Injectable()
export class NotificationsProducer {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Call this AFTER the transfer transaction commits. Enqueuing inside the
   * transaction can publish a job for a transfer that then rolls back.
   */
  async onTransferCompleted(payload: TransferCompletedJob): Promise<void> {
    await this.queue.add(TRANSFER_COMPLETED_JOB, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
}
