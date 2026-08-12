import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * The whole digital-channel entry path: register, log in, use the token,
 * rotate it, log out. Requires `docker compose up -d` and `npm run migration:run`.
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication<App>;
  const email = `e2e-${randomUUID()}@bank.test`;
  const password = 'S0me-Strong-Passphrase';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  let refreshToken: string;
  let accessToken: string;

  it('registers a new customer and returns a token pair', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.body).toHaveProperty('accessToken');
    // The user entity must never appear in the response.
    expect(res.body).not.toHaveProperty('passwordHash');

    refreshToken = (res.body as { refreshToken: string }).refreshToken;
  });

  it('rejects a duplicate registration with 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(409);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password, role: 'admin' }) // privilege-escalation attempt
      .expect(400);
  });

  it('logs in with the right credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    accessToken = (res.body as { accessToken: string }).accessToken;
    expect(accessToken).toBeDefined();
  });

  it('answers the same way for a wrong password as for an unknown email', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Wrong-Passphrase-1' })
      .expect(401);

    const unknownEmail = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@bank.test', password })
      .expect(401);

    // Different messages here would let an attacker enumerate customers.
    // requestId is intentionally unique per request, so compare the error only.
    const errorOf = (body: unknown) => (body as { error: unknown }).error;
    expect(errorOf(wrongPassword.body)).toEqual(errorOf(unknownEmail.body));
  });

  it('refuses a protected route without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/accounts').expect(401);
  });

  it('allows a protected route with the access token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true); // new customer, no accounts yet
  });

  it('rotates the refresh token and revokes the presented one', async () => {
    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(rotated.body).toHaveProperty('accessToken');

    // Replaying the old token must fail — this is the stolen-token case.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });
});
