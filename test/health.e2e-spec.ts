import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

/**
 * Boots the real module graph against real Postgres and Redis. Its job is to
 * catch wiring breakage — a missing provider, a circular import, an entity that
 * never got registered — which unit tests with mocked deps cannot see.
 * Requires `docker compose up -d`.
 */
describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('reports liveness without touching dependencies', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('reports readiness only when the database answers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.body).toHaveProperty('info.database.status', 'up');
  });

  it('attaches a request id to every response for tracing', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
