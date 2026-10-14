import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaModule } from './media.module.js';
import { S3ObjectStoreService } from './s3-object-store.service.js';

const S3_VARS = [
  'AWS_ENDPOINT_URL',
  'AWS_S3_BUCKET_NAME',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_S3_FORCE_PATH_STYLE',
];
const SECRET = 'module-test-secret-do-not-log';
const ACCESS = 'module-test-access-key';

function setEnv(values: Record<string, string>) {
  for (const name of S3_VARS) delete process.env[name];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const name of S3_VARS) delete process.env[name];
  vi.restoreAllMocks();
});

describe('MediaModule wiring', () => {
  it('boots unconfigured (no Railway bucket variables) with the store disabled', async () => {
    setEnv({});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(S3ObjectStoreService).isConfigured).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT configured'));
  });

  it('boots configured, and the startup log never contains the access key or the secret', async () => {
    setEnv({
      AWS_ENDPOINT_URL: 'https://t3.storageapi.dev',
      AWS_S3_BUCKET_NAME: 'mordwave-media-test',
      AWS_DEFAULT_REGION: 'iad',
      AWS_ACCESS_KEY_ID: ACCESS,
      AWS_SECRET_ACCESS_KEY: SECRET,
    });
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(S3ObjectStoreService).isConfigured).toBe(true);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('bucket=mordwave-media-test');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(ACCESS);
  });

  it('refuses to boot when the configuration is partial', async () => {
    setEnv({ AWS_ENDPOINT_URL: 'https://t3.storageapi.dev', AWS_S3_BUCKET_NAME: 'b' });
    await expect(Test.createTestingModule({ imports: [MediaModule] }).compile()).rejects.toThrow(
      /AWS_DEFAULT_REGION/,
    );
  });
});
