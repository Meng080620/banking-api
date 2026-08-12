import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  VersionColumn,
} from 'typeorm';
import { Customer } from '../customers/customer.entity';

export enum Currency {
  USD = 'USD',
  KHR = 'KHR',
}
export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  CLOSED = 'CLOSED',
}

@Entity('accounts')
// Last line of defence. The service checks the balance before debiting, but a
// bug or a manual UPDATE would otherwise be free to go negative silently.
@Check('"balance" >= 0')
export class Account {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true })
  @Column({ name: 'account_number', length: 20 })
  accountNumber: string;

  // Indexed: every "list my accounts" call filters on this column.
  @Index()
  @ManyToOne(() => Customer, { nullable: false })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;
  @Column({ type: 'enum', enum: Currency }) currency: Currency;
  @Column({ type: 'enum', enum: AccountStatus, default: AccountStatus.ACTIVE })
  status: AccountStatus;

  // MONEY: numeric(19,4). transformer keeps it a JS string to avoid float drift.
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    transformer: { to: (v: string) => v, from: (v: string) => v },
  })
  balance: string;

  @VersionColumn() version: number; // optimistic-lock counter
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
