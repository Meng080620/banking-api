import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Session } from './sessions.entity';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

// One source of truth: the string form is derived, so the JWT's real lifetime
// and the `expiresIn` we advertise to clients can never drift apart.
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ACCESS_TOKEN_TTL = `${ACCESS_TOKEN_TTL_SECONDS}s`;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string): Promise<AuthTokens> {
    if (await this.users.findOne({ where: { email } })) {
      throw new HttpException(
        { code: 'INVALID_REQUEST', message: 'Email already registered' },
        HttpStatus.CONFLICT,
      );
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.users.save(
      this.users.create({ email, passwordHash }),
    );
    return this.issueTokens(user);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.users.findOne({ where: { email } });

    // One generic error for "no such user", "wrong password" and "disabled".
    // Distinguishing them tells an attacker which emails are registered.
    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueTokens(user);
  }

  /**
   * Rotates the refresh token: the presented session is revoked and a new one
   * issued. If a stolen token is replayed after the real client has refreshed,
   * it hits a revoked session and fails.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret) throw this.invalidRefresh();

    const session = await this.sessions.findOne({
      where: { id: sessionId },
      relations: { user: true },
    });
    if (
      !session ||
      session.revoked ||
      session.expiresAt.getTime() < Date.now() ||
      !(await bcrypt.compare(secret, session.refreshHash))
    ) {
      throw this.invalidRefresh();
    }

    session.revoked = true;
    await this.sessions.save(session);

    return this.issueTokens(session.user);
  }

  async logout(refreshToken: string): Promise<void> {
    const [sessionId] = refreshToken.split('.');
    if (!sessionId) return; // Logout is idempotent — nothing to revoke.
    await this.sessions.update({ id: sessionId }, { revoked: true });
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL },
    );

    // Only the hash is stored. A database leak does not hand over live sessions.
    const secret = randomUUID() + randomUUID();
    const session = await this.sessions.save(
      this.sessions.create({
        user,
        refreshHash: await bcrypt.hash(secret, 10),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      }),
    );

    return {
      accessToken,
      // The session id travels with the secret so lookup is a primary-key hit
      // instead of a bcrypt comparison against every open session.
      refreshToken: `${session.id}.${secret}`,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private invalidRefresh(): HttpException {
    return new HttpException(
      { code: 'UNAUTHORIZED', message: 'Invalid refresh token' },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
