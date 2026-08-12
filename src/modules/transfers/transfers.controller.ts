import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferResponse } from './dto/transfer.response';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'transfers', version: '1' })
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Move money between accounts' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated, unique per logical transfer. Retrying with the ' +
      'same key replays the original result instead of moving money twice.',
  })
  @ApiResponse({ status: 201, type: TransferResponse })
  @ApiResponse({ status: 409, description: 'Duplicate request in flight' })
  @ApiResponse({
    status: 422,
    description: 'Insufficient balance, or key reused with a different body',
  })
  async create(
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<TransferResponse> {
    if (!idempotencyKey) {
      // Required, not optional: a mobile client on a flaky connection WILL
      // retry, and without a key the retry is a second debit.
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'Idempotency-Key header is required',
      });
    }

    const result = await this.transfers.create({
      userId: user.userId,
      idemKey: idempotencyKey,
      requestHash: hashRequest(dto),
      requestId: req.requestId,
      sourceId: dto.sourceId,
      destId: dto.destId,
      amount: dto.amount,
      currency: dto.currency,
    });

    return TransferResponse.from(result);
  }
}

/**
 * Fingerprints the request body so the same key sent with different details is
 * rejected rather than silently replaying the first transfer's result.
 */
function hashRequest(dto: CreateTransferDto): string {
  const canonical = [dto.sourceId, dto.destId, dto.amount, dto.currency].join(
    '|',
  );
  return createHash('sha256').update(canonical).digest('hex');
}
