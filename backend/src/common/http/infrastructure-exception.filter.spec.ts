import { BadRequestException, Logger, type ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureExceptionFilter } from './infrastructure-exception.filter.js';

describe('InfrastructureExceptionFilter', () => {
  let reply: ReturnType<typeof vi.fn>;
  let filter: InfrastructureExceptionFilter;
  const host = { getArgByIndex: () => ({}) } as unknown as ArgumentsHost;

  beforeEach(() => {
    reply = vi.fn();
    filter = new InfrastructureExceptionFilter({
      reply,
      end: vi.fn(),
      isHeadersSent: () => false,
    } as never);
  });

  const driver = (message: string, code?: string) => Object.assign(new Error(message), { code });

  it('statement timeout -> 504 REQUEST_TIMEOUT, with no SQL/params in the body', () => {
    filter.catch(
      new QueryFailedError('SELECT pw FROM users WHERE id = $1', ['secret-param'], driver('canceling statement due to statement timeout', '57014')),
      host,
    );
    expect(reply).toHaveBeenCalledWith(
      {},
      { statusCode: 504, errorCode: 'REQUEST_TIMEOUT', message: 'Request timed out' },
      504,
    );
    expect(JSON.stringify(reply.mock.calls)).not.toMatch(/SELECT|secret|users/);
  });

  it('pool acquisition failure -> 503 TEMPORARILY_UNAVAILABLE without host/credentials', () => {
    filter.catch(
      new Error('timeout exceeded when trying to connect'),
      host,
    );
    expect(reply).toHaveBeenCalledWith(
      {},
      {
        statusCode: 503,
        errorCode: 'TEMPORARILY_UNAVAILABLE',
        message: 'Service temporarily unavailable',
      },
      503,
    );
  });

  it('connection refused with host details in its message -> generic 503', () => {
    filter.catch(
      driver('connect ECONNREFUSED db.internal.example:5432 user=postgres', 'ECONNREFUSED'),
      host,
    );
    expect(reply.mock.calls[0][1]).toEqual({
      statusCode: 503,
      errorCode: 'TEMPORARILY_UNAVAILABLE',
      message: 'Service temporarily unavailable',
    });
    expect(JSON.stringify(reply.mock.calls)).not.toMatch(/db\.internal|postgres/);
  });

  it('body-parser too-large error -> 413 PAYLOAD_TOO_LARGE', () => {
    filter.catch(
      Object.assign(new Error('request entity too large'), {
        type: 'entity.too.large',
        status: 413,
        statusCode: 413,
        expose: true,
      }),
      host,
    );
    expect(reply).toHaveBeenCalledWith(
      {},
      { statusCode: 413, errorCode: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
      413,
    );
  });

  describe('body that carries a Content-Encoding (body-parser inflate: false)', () => {
    const encodingUnsupported = () =>
      Object.assign(new Error('content encoding unsupported'), {
        type: 'encoding.unsupported',
        status: 415,
        statusCode: 415,
        expose: true,
      });
    let logged: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      logged.mockRestore();
    });

    it('-> 415 UNSUPPORTED_CONTENT_ENCODING with the standard body', () => {
      filter.catch(encodingUnsupported(), host);
      expect(reply).toHaveBeenCalledWith(
        {},
        { statusCode: 415, errorCode: 'UNSUPPORTED_CONTENT_ENCODING', message: 'Content encoding not supported' },
        415,
      );
    });

    it('is not logged as an error, so no stack trace reaches the logs (like the 413)', () => {
      filter.catch(encodingUnsupported(), host);
      filter.catch(
        Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413, statusCode: 413 }),
        host,
      );
      expect(logged).not.toHaveBeenCalled();
    });

    it('infrastructure failures ARE still logged, with class, code and message only', () => {
      filter.catch(driver('connect ECONNREFUSED db.internal.example:5432', 'ECONNREFUSED'), host);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toMatch(/infrastructure_error kind=unavailable/);
    });
  });

  it('leaves ordinary HttpExceptions untouched', () => {
    filter.catch(new BadRequestException({ message: 'bad', errorCode: 'X' }), host);
    expect(reply).toHaveBeenCalledWith({}, { message: 'bad', errorCode: 'X' }, 400);
  });

  it('leaves unknown errors as a plain 500', () => {
    filter.catch(new Error('kaboom'), host);
    expect(reply.mock.calls[0][1]).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
