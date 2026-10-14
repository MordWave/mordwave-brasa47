import { describe, expect, it } from 'vitest';
import { describeS3Config, loadS3Config } from './s3.config.js';

const VALID = {
  AWS_ENDPOINT_URL: 'https://t3.storageapi.dev',
  AWS_S3_BUCKET_NAME: 'mordwave-media-abc123',
  AWS_DEFAULT_REGION: 'iad',
  AWS_ACCESS_KEY_ID: 'AKIA-TEST-ACCESS-KEY',
  AWS_SECRET_ACCESS_KEY: 'super-secret-value-do-not-leak',
};

describe('loadS3Config', () => {
  it('parses a valid configuration (virtual-hosted by default)', () => {
    expect(loadS3Config(VALID)).toEqual({
      endpoint: 'https://t3.storageapi.dev',
      region: 'iad',
      bucket: 'mordwave-media-abc123',
      accessKeyId: 'AKIA-TEST-ACCESS-KEY',
      secretAccessKey: 'super-secret-value-do-not-leak',
      forcePathStyle: false,
    });
  });

  it('normalises the endpoint to its origin and trims values', () => {
    const cfg = loadS3Config({ ...VALID, AWS_ENDPOINT_URL: ' https://t3.storageapi.dev/ ', AWS_DEFAULT_REGION: ' iad ' });
    expect(cfg?.endpoint).toBe('https://t3.storageapi.dev');
    expect(cfg?.region).toBe('iad');
  });

  it('returns null (media disabled) when no Railway bucket variable is set', () => {
    expect(loadS3Config({})).toBeNull();
    expect(loadS3Config({ AWS_ENDPOINT_URL: '  ', AWS_S3_BUCKET_NAME: '' })).toBeNull();
  });

  it('is not activated by generic AWS credentials alone (a developer shell may have them)', () => {
    expect(
      loadS3Config({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_DEFAULT_REGION: 'us-east-1' }),
    ).toBeNull();
  });

  it.each(Object.keys(VALID))('fails the boot when %s is missing or blank', (name) => {
    for (const value of [undefined, '', '   ']) {
      expect(() => loadS3Config({ ...VALID, [name]: value })).toThrow(new RegExp(name));
    }
  });

  it('lists every missing variable', () => {
    expect(() => loadS3Config({ AWS_ENDPOINT_URL: VALID.AWS_ENDPOINT_URL })).toThrow(
      /AWS_S3_BUCKET_NAME.*AWS_DEFAULT_REGION.*AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY/,
    );
  });

  it.each([
    ['http endpoint', 'http://t3.storageapi.dev', /https/],
    ['not a URL', 'storageapi', /valid absolute URL/],
    ['credentials in URL', 'https://u:p@t3.storageapi.dev', /credentials/],
    ['query', 'https://t3.storageapi.dev?x=1', /query/],
    ['path', 'https://t3.storageapi.dev/bucket', /origin without a path/],
  ])('rejects an invalid endpoint: %s', (_label, endpoint, message) => {
    expect(() => loadS3Config({ ...VALID, AWS_ENDPOINT_URL: endpoint })).toThrow(message);
  });

  it.each(['has space', 'a/b'])('rejects a bucket name that is not a plain name (%j)', (bucket) => {
    expect(() => loadS3Config({ ...VALID, AWS_S3_BUCKET_NAME: bucket })).toThrow(/AWS_S3_BUCKET_NAME/);
  });

  describe('AWS_S3_FORCE_PATH_STYLE', () => {
    it.each([
      [undefined, false],
      ['', false],
      ['false', false],
      ['true', true],
    ])('%j -> %s', (raw, expected) => {
      expect(loadS3Config({ ...VALID, AWS_S3_FORCE_PATH_STYLE: raw })?.forcePathStyle).toBe(expected);
    });

    it.each(['TRUE', 'True', '1', '0', 'yes', 'no', ' true', 'on'])('is a strict boolean: rejects %j', (raw) => {
      expect(() => loadS3Config({ ...VALID, AWS_S3_FORCE_PATH_STYLE: raw })).toThrow(/AWS_S3_FORCE_PATH_STYLE/);
    });
  });

  it('never puts a secret or the access key id in an error message', () => {
    const bad = [
      { ...VALID, AWS_ENDPOINT_URL: 'http://t3.storageapi.dev' },
      { ...VALID, AWS_S3_BUCKET_NAME: 'a b' },
      { ...VALID, AWS_S3_FORCE_PATH_STYLE: 'maybe' },
      { ...VALID, AWS_DEFAULT_REGION: '' },
    ];
    for (const env of bad) {
      try {
        loadS3Config(env);
        throw new Error('expected a throw');
      } catch (error) {
        const text = String((error as Error).message);
        expect(text).not.toContain(VALID.AWS_SECRET_ACCESS_KEY);
        expect(text).not.toContain(VALID.AWS_ACCESS_KEY_ID);
      }
    }
  });
});

describe('describeS3Config', () => {
  it('summarises the config without the access key or the secret', () => {
    const text = describeS3Config(loadS3Config(VALID)!);
    expect(text).toBe('endpoint=t3.storageapi.dev region=iad bucket=mordwave-media-abc123 style=virtual-hosted');
    expect(text).not.toContain(VALID.AWS_SECRET_ACCESS_KEY);
    expect(text).not.toContain(VALID.AWS_ACCESS_KEY_ID);
  });

  it('reports path style', () => {
    expect(describeS3Config({ ...loadS3Config(VALID)!, forcePathStyle: true })).toContain('style=path');
  });
});
