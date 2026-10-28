import { describe, expect, it } from 'vitest';
import { allowedFrontendOrigins, allowedOrigin, normalizeOrigin } from './share-origin.util.js';

describe('normalizeOrigin', () => {
  it('accepts a bare https origin (with or without a trailing slash) and http only on localhost', () => {
    expect(normalizeOrigin('https://web.example.test')).toBe('https://web.example.test');
    expect(normalizeOrigin(' https://Web.Example.test/ ')).toBe('https://web.example.test');
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it.each([
    ['plain http on a public host', 'http://web.example.test'],
    ['a path', 'https://web.example.test/menu'],
    ['a query', 'https://web.example.test?x=1'],
    ['a fragment', 'https://web.example.test#x'],
    ['credentials', 'https://user:pass@web.example.test'],
    ['another scheme', 'javascript:alert(1)'],
    ['not a URL', 'web.example.test'],
    ['empty', ''],
    ['a very long value', `https://${'a'.repeat(300)}.test`],
    ['a non-string', 5],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(normalizeOrigin(value)).toBeNull();
  });
});

describe('allowedFrontendOrigins / allowedOrigin', () => {
  it('reads the comma-separated FRONTEND_URL, ignoring invalid entries, and defaults like main.ts', () => {
    expect(allowedFrontendOrigins('https://a.example.test, http://localhost:5173,nonsense, https://b.example.test/')).toEqual([
      'https://a.example.test',
      'http://localhost:5173',
      'https://b.example.test',
    ]);
    expect(allowedFrontendOrigins(undefined)).toEqual(['http://localhost:5173']);
  });

  it('only believes a requested origin that is one of the allowed frontend origins', () => {
    const allowed = ['https://a.example.test'];
    expect(allowedOrigin('https://a.example.test/', allowed)).toBe('https://a.example.test');
    expect(allowedOrigin('https://evil.example.test', allowed)).toBeNull();
    expect(allowedOrigin('https://a.example.test.evil.test', allowed)).toBeNull();
    expect(allowedOrigin(undefined, allowed)).toBeNull();
    expect(allowedOrigin('https://a.example.test', [])).toBeNull();
  });
});
