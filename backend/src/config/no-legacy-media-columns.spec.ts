import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// products.image_url and businesses.logo_url were dropped (DropLegacyMediaUrls):
// the storage keys are the only image reference. No runtime code may mention the
// old columns again. (The API fields `imageUrl` / `logoUrl` are computed from the
// keys by the presenters and are not columns.)

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const runtime = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'migrations')));
const rel = (list: string[]) => list.map((f) => relative(SRC, f));

describe('the legacy media columns are gone from the runtime code', () => {
  it('no production file mentions image_url or logo_url', () => {
    expect(rel(runtime.filter((f) => /\b(image_url|logo_url)\b/.test(readFileSync(f, 'utf8'))))).toEqual([]);
  });

  it('the entities map no imageUrl / logoUrl column — only the storage keys', () => {
    for (const file of ['product/product.entity.ts', 'business/business.entity.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).not.toMatch(/\b(imageUrl|logoUrl)\b\s*[:?]/);
    }
    expect(readFileSync(join(SRC, 'product/product.entity.ts'), 'utf8')).toMatch(/image_storage_key/);
    expect(readFileSync(join(SRC, 'business/business.entity.ts'), 'utf8')).toMatch(/logo_storage_key/);
  });

  it('only the migration history still names the old columns (and the drop migration exists)', () => {
    const migrations = sourceFiles(join(SRC, 'migrations')).map((f) => relative(join(SRC, 'migrations'), f));
    expect(migrations).toContain('1790300000000-DropLegacyMediaUrls.ts');
  });
});
