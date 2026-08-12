import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoreBankingModule } from '../integrations/core-banking/core-banking.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IdempotencyKey } from './idempotency-key.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { Transfer } from './transfer.entity';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transfer, LedgerEntry, IdempotencyKey]),
    CoreBankingModule,
    NotificationsModule,
  ],
  controllers: [TransfersController],
  providers: [TransfersService],
  exports: [TransfersService],
})
export class TransfersModule {}
