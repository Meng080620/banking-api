import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CoreBankingClient } from './core-banking.client';

@Module({
  imports: [HttpModule],
  providers: [CoreBankingClient],
  exports: [CoreBankingClient],
})
export class CoreBankingModule {}
