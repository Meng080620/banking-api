import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Account } from '../accounts/account.entity';

export type TransferStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

@Entity('transfers')
@Check('"amount" > 0')
export class Transfer {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ length: 40 }) reference: string;
  @Column({ type: 'numeric', precision: 19, scale: 4 }) amount: string;
  @Column({ length: 3 }) currency: string;
  // Both indexed: a per-account transfer history filters on one or the other.
  @Index()
  @ManyToOne(() => Account)
  @JoinColumn({ name: 'source_account_id' })
  sourceAccount: Account;
  @Index()
  @ManyToOne(() => Account)
  @JoinColumn({ name: 'destination_account_id' })
  destinationAccount: Account;
  @Column({ length: 12, default: 'PENDING' }) status: TransferStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date;
}
