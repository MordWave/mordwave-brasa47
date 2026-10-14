import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Starting Nest must never be able to change the database schema. Only the
// explicit migrations (`npm run migration:run`) do. This scans every production
// source file so a future `synchronize: true`, `dropSchema` or `migrationsRun`
// is caught even where no runtime test boots that particular configuration.

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

// Comments are stripped so documentation can talk about these options.
const code = (file: string): string =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'migrations')));
const rel = (list: string[]) => list.map((f) => relative(SRC, f));

describe('TypeORM never changes the schema at startup', () => {
  it('scans the real configuration files', () => {
    const names = files.map((f) => relative(SRC, f));
    expect(names).toContain(join('config', 'typeorm.config.ts'));
    expect(names).toContain(join('config', 'data-source.ts'));
  });

  it('every `synchronize` setting in production code is the literal `false`', () => {
    const settings = files.flatMap((f) =>
      [...code(f).matchAll(/synchronize\s*:\s*([^,\n}]+)/g)].map((m) => ({ file: relative(SRC, f), value: m[1].trim() })),
    );
    expect(settings.length).toBeGreaterThanOrEqual(3); // both app branches + the CLI DataSource
    expect(settings.filter((s) => s.value !== 'false')).toEqual([]);
  });

  it('no production code calls DataSource.synchronize() or dropDatabase()', () => {
    expect(rel(files.filter((f) => /\.(synchronize|dropDatabase)\s*\(/.test(code(f))))).toEqual([]);
  });

  it('dropSchema and migrationsRun are not configured anywhere', () => {
    expect(rel(files.filter((f) => /\bdropSchema\b|\bmigrationsRun\b/.test(code(f))))).toEqual([]);
  });
});
