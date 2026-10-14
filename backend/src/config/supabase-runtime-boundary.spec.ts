import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Supabase may only be referenced by the manual legacy-media migration tooling
// (src/scripts/legacy-media), by migration history and by tests. This guards
// the boundary: production code under src/ must never import the Supabase
// client, read SUPABASE_* variables, or register a Supabase config.

const SRC = join(__dirname, '..');
const TOOLING = join(SRC, 'scripts', 'legacy-media');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const runtimeFiles = sourceFiles(SRC).filter(
  (file) => !file.startsWith(TOOLING) && !file.startsWith(join(SRC, 'migrations')),
);

describe('Supabase is isolated from the API runtime', () => {
  it('scans a meaningful set of production files', () => {
    expect(runtimeFiles.length).toBeGreaterThan(50);
    expect(runtimeFiles.some((f) => f.endsWith('app.module.ts'))).toBe(true);
    expect(runtimeFiles.some((f) => f.endsWith('image-storage.service.ts'))).toBe(true);
  });

  it('no production file imports @supabase/supabase-js', () => {
    const offenders = runtimeFiles.filter((f) => /@supabase\/supabase-js/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('no production file reads a SUPABASE_* environment variable', () => {
    const offenders = runtimeFiles.filter((f) => /SUPABASE_[A-Z_]+/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('there is no Supabase config module any more, and AppModule does not load one', () => {
    expect(existsSync(join(SRC, 'config', 'supabase.config.ts'))).toBe(false);
    const appModule = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    expect(appModule).not.toMatch(/supabase/i);
  });

  it('the migration tooling is the only code that still imports the Supabase client', () => {
    const importers = sourceFiles(SRC).filter((f) => /@supabase\/supabase-js/.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => relative(SRC, f))).toEqual([join('scripts', 'legacy-media', 'cli.ts')]);
  });
});
