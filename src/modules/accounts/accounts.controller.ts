import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
// `import type` is required: these appear in decorated signatures, and with
// isolatedModules + emitDecoratorMetadata a value import would be emitted.
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AccountsService } from './accounts.service';
import { AccountResponse, BalanceResponse } from './dto/account.response';

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'accounts', version: '1' })
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's own accounts" })
  @ApiResponse({ status: 200, type: [AccountResponse] })
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountResponse[]> {
    const accounts = await this.accounts.listForUser(user.userId);
    return accounts.map((account) => AccountResponse.from(account));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one account' })
  @ApiResponse({ status: 200, type: AccountResponse })
  @ApiResponse({ status: 404, description: 'Not found, or not the caller’s' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountResponse> {
    return AccountResponse.from(await this.accounts.getOwned(id, user.userId));
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Live balance, read from the bank core' })
  @ApiResponse({ status: 200, type: BalanceResponse })
  @ApiResponse({ status: 502, description: 'Core banking unavailable' })
  @ApiResponse({ status: 504, description: 'Core banking timed out' })
  async balance(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<BalanceResponse> {
    const result = await this.accounts.getLiveBalance(
      id,
      user.userId,
      req.requestId, // same id continues into the middleware call
    );
    return BalanceResponse.from(result);
  }
}
