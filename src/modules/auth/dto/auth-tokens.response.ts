import { ApiProperty } from '@nestjs/swagger';
import { AuthTokens } from '../auth.service';

/**
 * The view model for the auth endpoints. Handlers return this, never a User
 * entity — that is what keeps `passwordHash` from ever reaching a client.
 */
export class AuthTokensResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty({ example: 'Bearer' }) tokenType: string;
  @ApiProperty({ example: 900, description: 'Access token lifetime, seconds' })
  expiresIn: number;

  static from(tokens: AuthTokens): AuthTokensResponse {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      expiresIn: tokens.expiresIn,
    };
  }
}
