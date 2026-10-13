import { describe, expect, it, vi } from 'vitest';
import { applyHttpServerTimeouts, configureHttpApp } from './app.setup.js';

describe('applyHttpServerTimeouts', () => {
  it('sets keepAlive 65s, headers 66s and request 120s', () => {
    const server = { keepAliveTimeout: 0, headersTimeout: 0, requestTimeout: 0 };
    applyHttpServerTimeouts(server);
    expect(server).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000, requestTimeout: 120_000 });
  });

  it('keeps headersTimeout above keepAliveTimeout (required by Node)', () => {
    const server = { keepAliveTimeout: 0, headersTimeout: 0, requestTimeout: 0 };
    applyHttpServerTimeouts(server);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBeGreaterThan(server.headersTimeout);
  });
});

describe('configureHttpApp', () => {
  it('replaces only the JSON body parser, with a 200kb limit', () => {
    const useBodyParser = vi.fn();
    configureHttpApp({ useBodyParser } as never);
    expect(useBodyParser).toHaveBeenCalledTimes(1);
    expect(useBodyParser).toHaveBeenCalledWith('json', { limit: '200kb' });
  });
});
