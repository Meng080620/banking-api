import { ApiProperty } from '@nestjs/swagger';
import { BalanceResult } from '../../integrations/core-banking/core-banking.client';
import { Account, AccountStatus, Currency } from '../account.entity';

/**
 * View model for an account. Note what is absent: the internal `version`
 * optimistic-lock counter and the customer relation. Returning the entity
 * directly would ship both to every mobile client.
 */
export class AccountResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '000123456789' }) accountNumber: string;
  @ApiProperty({ enum: Currency }) currency: Currency;
  @ApiProperty({ enum: AccountStatus }) status: AccountStatus;
  @ApiProperty({ example: '1500.0000', description: 'Decimal string' })
  balance: string;
  @ApiProperty() createdAt: Date;

  static from(account: Account): AccountResponse {
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency,
      status: account.status,
      balance: account.balance,
      createdAt: account.createdAt,
    };
  }
}

export class BalanceResponse {
  @ApiProperty() accountNumber: string;
  @ApiProperty() currency: string;
  @ApiProperty({ example: '1500.0000' }) available: string;
  @ApiProperty({ description: 'Where the figure came from' })
  source: 'CORE_BANKING';

  static from(result: BalanceResult): BalanceResponse {
    return {
      accountNumber: result.accountNumber,
      currency: result.currency,
      available: result.available,
      source: 'CORE_BANKING',
    };
  }
}
