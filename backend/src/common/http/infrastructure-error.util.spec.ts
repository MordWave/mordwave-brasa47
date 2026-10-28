import { QueryFailedError } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { classifyInfrastructureError } from './infrastructure-error.util.js';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
const queryFailed = (driverError: Error) =>
  new QueryFailedError('SELECT secret FROM users WHERE token = $1', ['s3cr3t'], driverError);

describe('classifyInfrastructureError', () => {
  it('statement_timeout (SQLSTATE 57014, wrapped by TypeORM) -> timeout', () => {
    const error = queryFailed(withCode('canceling statement due to statement timeout', '57014'));
    expect(classifyInfrastructureError(error)).toBe('timeout');
  });

  it('pg client-side query_timeout -> timeout', () => {
    expect(classifyInfrastructureError(new Error('Query read timeout'))).toBe('timeout');
    expect(classifyInfrastructureError(queryFailed(new Error('Query read timeout')))).toBe('timeout');
  });

  it('pool could not hand out a connection in time -> unavailable', () => {
    expect(classifyInfrastructureError(new Error('timeout exceeded when trying to connect'))).toBe(
      'unavailable',
    );
    expect(
      classifyInfrastructureError(new Error('Connection terminated due to connection timeout')),
    ).toBe('unavailable');
  });

  it.each([
    ['ECONNREFUSED'],
    ['ECONNRESET'],
    ['ETIMEDOUT'],
    ['ENOTFOUND'],
    ['EAI_AGAIN'],
    ['53300'],
    ['57P01'],
    ['57P03'],
    ['08006'],
    ['08001'],
  ])('connection-level failure %s -> unavailable', (code) => {
    expect(classifyInfrastructureError(withCode('boom', code))).toBe('unavailable');
    expect(classifyInfrastructureError(queryFailed(withCode('boom', code)))).toBe('unavailable');
  });

  it('follows error.cause too', () => {
    const error = new Error('wrapper', { cause: withCode('x', 'ECONNREFUSED') });
    expect(classifyInfrastructureError(error)).toBe('unavailable');
  });

  it('body-parser entity.too.large -> payload-too-large', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      statusCode: 413,
    });
    expect(classifyInfrastructureError(error)).toBe('payload-too-large');
  });

  it('body-parser encoding.unsupported (inflate: false) -> unsupported-content-encoding, also through error.cause', () => {
    const error = Object.assign(new Error('content encoding unsupported'), {
      type: 'encoding.unsupported',
      status: 415,
      statusCode: 415,
    });
    expect(classifyInfrastructureError(error)).toBe('unsupported-content-encoding');
    expect(classifyInfrastructureError(new Error('wrapper', { cause: error }))).toBe('unsupported-content-encoding');
  });

  it.each([
    ['an ordinary error', new Error('something else')],
    ['another body-parser 415 (charset.unsupported)', Object.assign(new Error('x'), { type: 'charset.unsupported', status: 415, statusCode: 415 })],
    ['a unique violation', queryFailed(withCode('duplicate key', '23505'))],
    ['a serialization failure', queryFailed(withCode('could not serialize', '40001'))],
    ['a validation-style 400', Object.assign(new Error('bad'), { status: 400, statusCode: 400 })],
    ['null', null],
    ['a string', 'ETIMEDOUT'],
  ])('leaves %s unclassified', (_label, error) => {
    expect(classifyInfrastructureError(error)).toBeNull();
  });
});
