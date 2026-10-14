import { afterEach, describe, expect, it } from 'vitest';
import { businessLogoKey, productImageKey } from './media-key.util.js';
import { MediaUrlService } from './media-url.service.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const OBJ = '33333333-3333-4333-8333-333333333333';
const KEY = productImageKey(BIZ, PROD, OBJ);

function serviceWith(base: string | undefined): MediaUrlService {
  if (base === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL;
  else process.env.MEDIA_PUBLIC_BASE_URL = base;
  return new MediaUrlService();
}

afterEach(() => {
  delete process.env.MEDIA_PUBLIC_BASE_URL;
});

describe('MediaUrlService.parseBaseUrl', () => {
  it.each([[undefined], [''], ['   ']])('treats %j as "not configured"', (raw) => {
    expect(MediaUrlService.parseBaseUrl(raw)).toBeNull();
  });

  it('normalises the origin and strips trailing slashes', () => {
    expect(MediaUrlService.parseBaseUrl(' https://api.example.com/ ')).toBe('https://api.example.com');
    expect(MediaUrlService.parseBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(MediaUrlService.parseBaseUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
  });

  it('requires https for any non-local host (mixed content would block http:// images)', () => {
    expect(() => MediaUrlService.parseBaseUrl('http://api.example.com')).toThrow(/https/);
  });

  it.each([
    ['not-a-url'],
    ['ftp://api.example.com'],
    ['https://user:pw@api.example.com'],
    ['https://api.example.com/?a=1'],
    ['https://api.example.com/#x'],
  ])('rejects %j so a typo fails the boot', (raw) => {
    expect(() => MediaUrlService.parseBaseUrl(raw)).toThrow(/MEDIA_PUBLIC_BASE_URL/);
  });
});

describe('MediaUrlService.resolve', () => {
  it('returns the stable /media URL when a key exists and the base URL is configured', () => {
    const svc = serviceWith('https://api.example.com/');
    expect(svc.resolve(KEY)).toBe(`https://api.example.com/media/${KEY}`);
    const logo = businessLogoKey(BIZ, OBJ);
    expect(svc.resolve(logo)).toBe(`https://api.example.com/media/${logo}`);
  });

  it.each([[null], [undefined], ['']])('has no image when the key is %j', (key) => {
    expect(serviceWith('https://api.example.com').resolve(key)).toBeNull();
  });

  it('has no image when the base URL is not configured (there is no other source)', () => {
    expect(serviceWith(undefined).resolve(KEY)).toBeNull();
  });

  it('never builds a URL from a malformed key', () => {
    const svc = serviceWith('https://api.example.com');
    for (const bad of ['../../etc/passwd', 'businesses/x/y.webp', KEY.toUpperCase(), 'https://evil.example/x.png']) {
      expect(svc.resolve(bad)).toBeNull();
    }
  });

  it('takes a single argument: no legacy URL can be passed in', () => {
    expect(serviceWith('https://api.example.com').resolve.length).toBe(1);
  });
});
