import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsProducer } from './notifications.producer';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  providers: [NotificationsProducer, NotificationsProcessor],
  // BullModule is re-exported so HealthModule can inject the same queue and
  // ping the connection the workers really use.
  exports: [NotificationsProducer, BullModule],
})
export class NotificationsModule {}
