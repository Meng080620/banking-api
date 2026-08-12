import { Module } from '@nestjs/common';
import { CoreBankingMockController } from './core-banking-mock.controller';

/**
 * Stand-in for the bank's core middleware so the API can be developed and
 * tested without it. Registered only outside production — see AppModule.
 */
@Module({ controllers: [CoreBankingMockController] })
export class CoreBankingMockModule {}
