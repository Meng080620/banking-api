import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BalanceResult,
  CoreBankingClient,
} from '../integrations/core-banking/core-banking.client';
import { Account, AccountStatus } from './account.entity';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly core: CoreBankingClient,
  ) {}

  /** Accounts are always scoped by the caller — there is no unscoped list. */
  listForUser(userId: string): Promise<Account[]> {
    return this.accounts.find({
      where: {
        customer: { user: { id: userId } },
        status: AccountStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Ownership is a condition of the query, not a check after it. Loading by id
   * and comparing owners in JS is the version people forget to write.
   */
  async getOwned(accountId: string, userId: string): Promise<Account> {
    const account = await this.accounts.findOne({
      where: { id: accountId, customer: { user: { id: userId } } },
      relations: { customer: true },
    });
    if (!account) {
      // 404 rather than 403: confirming the account exists but belongs to
      // someone else leaks which account numbers are real.
      throw new HttpException(
        { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' },
        404,
      );
    }
    return account;
  }

  /**
   * Authoritative balance comes from the bank's core, not our table. Our
   * `balance` column is a local projection for validation speed; the core is
   * the record of truth, so the customer is shown what the core says.
   */
  async getLiveBalance(
    accountId: string,
    userId: string,
    requestId: string,
  ): Promise<BalanceResult> {
    const account = await this.getOwned(accountId, userId);
    return this.core.getBalance(account.accountNumber, requestId);
  }
}
