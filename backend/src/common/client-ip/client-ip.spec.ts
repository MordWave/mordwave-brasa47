import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { extractClientInfo } from '../../audit/request-client-info.util.js';
import { parseClientIpHeader, resolveClientIp } from './client-ip.js';

const makeReq = (headers: Record<string, string | string[] | undefined>, ip?: string) =>
  ({ headers, ip }) as unknown as Request;

describe('parseClientIpHeader', () => {
  it('returns null when unset or blank', () => {
    expect(parseClientIpHeader(undefined)).toBeNull();
    expect(parseClientIpHeader('')).toBeNull();
    expect(parseClientIpHeader('   ')).toBeNull();
  });

  it('normalizes a plain header name to lowercase', () => {
    expect(parseClientIpHeader('X-Real-IP')).toBe('x-real-ip');
    expect(parseClientIpHeader(' cf-connecting-ip ')).toBe('cf-connecting-ip');
  });

  it('rejects malformed header names so a typo fails at startup', () => {
    expect(() => parseClientIpHeader('x real ip')).toThrow(/Invalid CLIENT_IP_HEADER/);
    expect(() => parseClientIpHeader('x-real-ip:')).toThrow(/Invalid CLIENT_IP_HEADER/);
  });

  it('rejects list-valued headers (those belong to TRUST_PROXY)', () => {
    expect(() => parseClientIpHeader('x-forwarded-for')).toThrow(/TRUST_PROXY/);
    expect(() => parseClientIpHeader('Forwarded')).toThrow(/TRUST_PROXY/);
  });
});

describe('resolveClientIp', () => {
  afterEach(() => {
    delete process.env.CLIENT_IP_HEADER;
  });

  it('uses the configured header when it holds a valid IPv4', () => {
    const req = makeReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1');
    expect(resolveClientIp(req, 'x-real-ip')).toBe('203.0.113.7');
  });

  it('accepts a valid IPv6 address (and trims surrounding whitespace)', () => {
    const req = makeReq({ 'x-real-ip': ' 2001:db8::1 ' }, '10.0.0.1');
    expect(resolveClientIp(req, 'x-real-ip')).toBe('2001:db8::1');
  });

  it.each([
    ['garbage', 'not-an-ip'],
    ['a hostname', 'example.com'],
    ['a list of addresses', '203.0.113.7, 10.0.0.2'],
    ['an address with a port', '203.0.113.7:443'],
    ['an out-of-range octet', '300.1.1.1'],
    ['an empty value', ''],
  ])('ignores the header when it holds %s and falls back to req.ip', (_label, value) => {
    const req = makeReq({ 'x-real-ip': value }, '10.0.0.1');
    expect(resolveClientIp(req, 'x-real-ip')).toBe('10.0.0.1');
  });

  it('ignores a repeated (array) header value', () => {
    const req = makeReq({ 'x-real-ip': ['203.0.113.7', '203.0.113.8'] }, '10.0.0.1');
    expect(resolveClientIp(req, 'x-real-ip')).toBe('10.0.0.1');
  });

  it('falls back to req.ip when the header is absent', () => {
    expect(resolveClientIp(makeReq({}, '10.0.0.1'), 'x-real-ip')).toBe('10.0.0.1');
  });

  it('ignores x-real-ip entirely when no header is configured', () => {
    const req = makeReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1');
    expect(resolveClientIp(req, null)).toBe('10.0.0.1');
  });

  it('returns null when there is neither a usable header nor req.ip', () => {
    expect(resolveClientIp(makeReq({}), 'x-real-ip')).toBeNull();
  });

  it('reads CLIENT_IP_HEADER from the environment by default', () => {
    const req = makeReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1');
    expect(resolveClientIp(req)).toBe('10.0.0.1');
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    expect(resolveClientIp(req)).toBe('203.0.113.7');
  });
});

describe('extractClientInfo (audit) shares resolveClientIp', () => {
  afterEach(() => {
    delete process.env.CLIENT_IP_HEADER;
  });

  it('records the same address resolveClientIp returns', () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    const req = makeReq({ 'x-real-ip': '203.0.113.7', 'user-agent': 'jest' }, '10.0.0.1');
    expect(extractClientInfo(req)).toEqual({ ipAddress: '203.0.113.7', userAgent: 'jest' });
  });

  it('falls back to req.ip with no header configured', () => {
    const req = makeReq({}, '10.0.0.1');
    expect(extractClientInfo(req)).toEqual({ ipAddress: '10.0.0.1', userAgent: null });
  });
});
