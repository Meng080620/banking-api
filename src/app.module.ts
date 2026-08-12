import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { CoreBankingMockModule } from './mock/core-banking-mock.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { TransfersModule } from './modules/transfers/transfers.module';

/** The fake upstream ships in dev/test only — never in a production image. */
const mockModules =
  process.env.NODE_ENV === 'production' ? [] : [CoreBankingMockModule];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    TypeOrmModule.forRootAsync({ useFactory: () => buildDataSourceOptions() }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
        },
      }),
    }),
    // Blanket limit. Money-moving routes should override this with a tighter one.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    HealthModule,
    AuthModule,
    AccountsModule,
    TransfersModule,
    NotificationsModule,
    ...mockModules,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Every log line and error response carries this id — it is how you trace
    // one customer's failed transfer across API, worker and upstream logs.
    // '{*path}' not '*' — path-to-regexp v8 (Express 5) dropped the bare
    // wildcard, and Nest only auto-converts it with a deprecation warning.
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
