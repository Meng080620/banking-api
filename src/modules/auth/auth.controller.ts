import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthTokensResponse } from './dto/auth-tokens.response';
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Create a customer login' })
  @ApiResponse({ status: 201, type: AuthTokensResponse })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDto): Promise<AuthTokensResponse> {
    return AuthTokensResponse.from(
      await this.auth.register(dto.email, dto.password),
    );
  }

  // Tighter than the global limit: login is the endpoint credential-stuffing
  // attacks aim at, and 100 attempts a minute is an open door.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for tokens' })
  @ApiResponse({ status: 200, type: AuthTokensResponse })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto): Promise<AuthTokensResponse> {
    return AuthTokensResponse.from(
      await this.auth.login(dto.email, dto.password),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate an expiring access token' })
  @ApiResponse({ status: 200, type: AuthTokensResponse })
  async refresh(@Body() dto: RefreshDto): Promise<AuthTokensResponse> {
    return AuthTokensResponse.from(await this.auth.refresh(dto.refreshToken));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh session' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
