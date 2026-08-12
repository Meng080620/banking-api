import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The validation boundary. Nothing reaches a service until it has the right
 * shape — ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`, so
 * unknown fields are a 400 rather than something silently persisted.
 */
export class RegisterDto {
  @ApiProperty({ example: 'customer@bank.com.kh' })
  @IsEmail()
  @MaxLength(160)
  email: string;

  @ApiProperty({ example: 'S0me-Strong-Passphrase', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'customer@bank.com.kh' })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'The refreshToken returned by login' })
  @IsString()
  @MaxLength(200)
  refreshToken: string;
}
