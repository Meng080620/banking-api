import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() action: string; // LOGIN, TRANSFER_CREATED, BENEFICIARY_DELETED …
  @Column({ nullable: true }) resource: string;
  @Column({ nullable: true }) resourceId: string;
  @Column() requestId: string;
  @Column({ nullable: true }) ip: string;
  @Column() result: 'SUCCESS' | 'FAILURE';
  @CreateDateColumn({ type: 'timestamptz' }) timestamp: Date;
}
