import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

/** The stored result we replay when a client retries with the same key. */
export interface TransferResult {
  id: string;
  reference: string;
  status: string;
}

@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ length: 120 }) key: string; // the client's key IS the PK

  @Column({ name: 'user_id', length: 64 }) userId: string;

  // Detects the same key being reused with a different body — that is a client
  // bug, and replaying the old result would hide it.
  @Column({ name: 'request_hash', length: 64 }) requestHash: string;

  @Column({ type: 'jsonb', nullable: true }) response: TransferResult | null;

  @Column({ length: 20, default: 'IN_PROGRESS' }) status: IdempotencyStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
