import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Account } from '../accounts/account.entity';
import { Transfer } from './transfer.entity';

export enum EntryType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

/**
 * Double-entry ledger. Every transfer writes exactly two rows — one DEBIT and
 * one CREDIT of the same amount — so the sum of all entries is always zero.
 * The ledger is append-only: corrections are new reversing entries, never updates.
 */
@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Index()
  @ManyToOne(() => Transfer, { nullable: false })
  @JoinColumn({ name: 'transfer_id' })
  transfer: Transfer;

  @Index()
  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column({ type: 'enum', enum: EntryType }) type: EntryType;

  // MONEY: numeric(19,4), carried as a string end-to-end — never a JS number.
  @Column({ type: 'numeric', precision: 19, scale: 4 }) amount: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
