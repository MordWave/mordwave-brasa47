import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
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

  // @nestjs/platform-express >= 12.3 turns the http-errors that body-parser raises into an HttpException that keeps the
  // original under `cause`, so the body-parser `type` has to be found along the chain.
  describe('body-parser errors wrapped by the platform adapter', () => {
    const tooLarge = () =>
      Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413, statusCode: 413 });
    const encodingUnsupported = () =>
      Object.assign(new Error('content encoding unsupported'), { type: 'encoding.unsupported', status: 415, statusCode: 415 });

    it('entity.too.large inside an HttpException cause -> payload-too-large', () => {
      const wrapped = new HttpException('request entity too large', 413, { cause: tooLarge() });
      expect(classifyInfrastructureError(wrapped)).toBe('payload-too-large');
    });

    it('entity.too.large inside a plain Error cause -> payload-too-large', () => {
      expect(classifyInfrastructureError(new Error('wrapper', { cause: tooLarge() }))).toBe('payload-too-large');
    });

    it('encoding.unsupported inside an HttpException cause -> unsupported-content-encoding', () => {
      const wrapped = new HttpException('content encoding unsupported', 415, { cause: encodingUnsupported() });
      expect(classifyInfrastructureError(wrapped)).toBe('unsupported-content-encoding');
    });

    it('is found up to the traversal limit (4 levels) and no further', () => {
      const nest = (depth: number): Error => (depth === 0 ? tooLarge() : new Error('wrapper', { cause: nest(depth - 1) }));
      expect(classifyInfrastructureError(nest(3))).toBe('payload-too-large');
      expect(classifyInfrastructureError(nest(4))).toBeNull();
    });

    it('survives a cyclic cause chain', () => {
      const a: Error & { cause?: unknown } = new Error('a');
      const b: Error & { cause?: unknown } = new Error('b', { cause: a });
      a.cause = b;
      expect(classifyInfrastructureError(a)).toBeNull();
    });

    it.each([
      ['a cause that is a string', new Error('x', { cause: 'entity.too.large' })],
      ['a null cause', new Error('x', { cause: null })],
      ['a cause whose type is not a string match', new Error('x', { cause: { type: ['entity.too.large'] } })],
      ['a 413 cause that is not body-parser (no `type`)', new HttpException('x', 413, { cause: Object.assign(new Error('y'), { status: 413 }) })],
      ['a Nest PayloadTooLargeException (Multer file size) with no body-parser cause', new PayloadTooLargeException('File too large')],
      ['an HttpException 413 without cause', new HttpException('too big', 413)],
      ['a Nest BadRequestException', new BadRequestException('bad')],
      ['a wrapped charset.unsupported 415', new HttpException('x', 415, { cause: Object.assign(new Error('y'), { type: 'charset.unsupported', status: 415, statusCode: 415 }) })],
      ['a wrapped entity.parse.failed 400', new HttpException('x', 400, { cause: Object.assign(new Error('y'), { type: 'entity.parse.failed', status: 400, statusCode: 400 }) })],
    ])('does not classify %s', (_label, error) => {
      expect(classifyInfrastructureError(error)).toBeNull();
    });

    it('a wrapped infrastructure failure is still recognised (cause chain, unchanged)', () => {
      const wrapped = new HttpException('x', 503, { cause: withCode('boom', 'ECONNREFUSED') });
      expect(classifyInfrastructureError(wrapped)).toBe('unavailable');
    });
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
