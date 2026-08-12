import { ApiProperty } from '@nestjs/swagger';
import { TransferResult } from '../idempotency-key.entity';

export class TransferResponse {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'TRF-1786286537606' }) reference: string;
  @ApiProperty({ example: 'COMPLETED' }) status: string;

  static from(result: TransferResult): TransferResponse {
    return {
      id: result.id,
      reference: result.reference,
      status: result.status,
    };
  }
}
