import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

interface MockTransferBody {
  reference: string;
  amount: string;
  currency: string;
}

/**
 * Fake core-banking middleware. `?fail=timeout|500|400` lets a test drive every
 * failure mode of CoreBankingClient without a real upstream.
 */
@ApiExcludeController()
@Controller({ path: 'middleware', version: '1' })
export class CoreBankingMockController {
  @Get('accounts/:accountNumber/balance')
  async balance(
    @Param('accountNumber') accountNumber: string,
    @Query('fail') fail?: string,
  ) {
    if (fail === '500') throw new HttpException('core down', 500);
    if (fail === '400') throw new HttpException('bad account', 400);
    if (fail === 'timeout') await new Promise((r) => setTimeout(r, 10_000));

    // The upstream's OWN field names — deliberately not our API shape.
    return {
      acctNo: accountNumber,
      ccy: 'USD',
      avail: '1500.0000',
      ledger: '1500.0000',
      ts: Date.now(),
    };
  }

  @Post('transfers')
  transfer(@Body() body: MockTransferBody) {
    return { ref: `MW-${body.reference}`, state: 'ACCEPTED' as const };
  }
}
