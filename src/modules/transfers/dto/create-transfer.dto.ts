import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID, Matches } from 'class-validator';
import { Currency } from '../../accounts/account.entity';

export class CreateTransferDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destId: string;

  @ApiProperty({
    example: '150.0000',
    description: 'Positive decimal string, max 4 decimal places',
  })
  // A string, validated by regex, never a `number`. IEEE-754 cannot hold 0.1
  // exactly, and a cent lost per transaction is a reconciliation incident.
  @Matches(/^\d{1,15}(\.\d{1,4})?$/, {
    message: 'amount must be a positive decimal string, max 4 dp',
  })
  amount: string;

  @ApiProperty({ enum: Currency })
  @IsEnum(Currency)
  currency: Currency;
}
