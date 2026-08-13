import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger';
import { resolveCorsOrigin, resolveTrustProxy } from './config/cors.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Behind nginx every request arrives from the proxy's IP. Without this the
  // throttler buckets all customers together and logs record one address.
  const trustProxy = resolveTrustProxy(process.env);
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  app.use(helmet());
  app.enableCors({ origin: resolveCorsOrigin(process.env), credentials: true });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // /api/v1
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // ...and reject requests that send them
      transform: true,
    }),
  );
  // AllExceptionsFilter and LoggingInterceptor are registered in AppModule via
  // APP_FILTER / APP_INTERCEPTOR so they can use dependency injection.

  setupSwagger(app);

  // Finish in-flight requests before the process exits on SIGTERM.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api/v1`, 'Bootstrap');
}

bootstrap().catch((err) => {
  Logger.error('Failed to start application', err, 'Bootstrap');
  process.exit(1);
});
