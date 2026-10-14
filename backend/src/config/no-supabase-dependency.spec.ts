import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Media lives only in the Railway Bucket behind /media
// (products.image_storage_key / businesses.logo_storage_key). The Supabase
// Storage migration is finished and its tooling was removed, so nothing in the
// backend may depend on Supabase any more. This fails if one comes back.

const BACKEND = join(__dirname, '..', '..');
const SRC = join(BACKEND, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

// Migrations are history (they may mention the old provider in comments);
// everything else under src/ is production code.
const productionFiles = sourceFiles(SRC).filter((file) => !file.startsWith(join(SRC, 'migrations')));

describe('the backend has no Supabase dependency', () => {
  it('scans a meaningful set of production files', () => {
    expect(productionFiles.length).toBeGreaterThan(50);
    expect(productionFiles.some((f) => f.endsWith('app.module.ts'))).toBe(true);
    expect(productionFiles.some((f) => f.endsWith('image-storage.service.ts'))).toBe(true);
  });

  it('no source file imports the Supabase client', () => {
    const offenders = sourceFiles(SRC).filter((f) => /@supabase\//.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('no production file reads a SUPABASE_* environment variable', () => {
    const offenders = productionFiles.filter((f) => /SUPABASE_[A-Z_]+/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('there is no Supabase config module, and AppModule does not mention Supabase', () => {
    expect(existsSync(join(SRC, 'config', 'supabase.config.ts'))).toBe(false);
    expect(readFileSync(join(SRC, 'app.module.ts'), 'utf8')).not.toMatch(/supabase/i);
  });

  it('the legacy media migration tooling is gone', () => {
    expect(existsSync(join(SRC, 'scripts', 'legacy-media'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['media:legacy']).toBeUndefined();
  });

  it('package.json and the lockfile have no Supabase package', () => {
    const pkg = JSON.parse(readFileSync(join(BACKEND, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(declared.filter((name) => /supabase/i.test(name))).toEqual([]);
    const lock = JSON.parse(readFileSync(join(BACKEND, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((name) => /@supabase\//.test(name))).toEqual([]);
  });

  it('.env.example documents no SUPABASE_* variable', () => {
    expect(readFileSync(join(BACKEND, '.env.example'), 'utf8')).not.toMatch(/SUPABASE_/);
  });
});
