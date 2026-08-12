import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));

  const hostFor = (): ArgumentsHost =>
    ({
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/api/v1/test', requestId: 'req-1' }),
      }),
    }) as unknown as ArgumentsHost;

  const filter = new AllExceptionsFilter();

  beforeEach(() => jest.clearAllMocks());

  it('wraps a thrown HttpException in the standard envelope', () => {
    filter.catch(
      new HttpException(
        { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
      hostFor(),
    );

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' },
      requestId: 'req-1',
    });
  });

  it('never leaks the detail of an unexpected error', () => {
    // A raw Error means a bug. The client gets a generic message; the stack
    // goes to the logs only.
    filter.catch(new Error('column "passwrd" does not exist'), hostFor());

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      requestId: 'req-1',
    });
  });

  it('passes a failing health check through untouched', () => {
    // Regression: the envelope used to flatten this into "Internal server
    // error", so a 503 told whoever was on call nothing about WHICH
    // dependency had died.
    const healthResult = {
      status: 'error',
      info: { database: { status: 'up' } },
      error: { redis: { status: 'down', message: 'timed out after 2000ms' } },
      details: {
        database: { status: 'up' },
        redis: { status: 'down', message: 'timed out after 2000ms' },
      },
    };

    filter.catch(new ServiceUnavailableException(healthResult), hostFor());

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(healthResult);
  });
});
