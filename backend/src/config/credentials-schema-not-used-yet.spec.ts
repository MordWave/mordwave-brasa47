import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// 8D.2d-2a only PREPARES the schema (AddCredentialsSecurity): users.credentials_version and
// users.must_change_password must exist in production before any code reads them, because mapping them on the
// User entity makes every authenticated request select them. Until the migration is confirmed applied in
// production, no runtime code may mention them. The PR that starts using them (8D.2d-2b) deletes this file on
// purpose: that is the gate.

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const runtime = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'migrations')));

describe('the credentials-security columns are not used by runtime code yet', () => {
  it('no production file mentions the new columns or their camelCase names', () => {
    const offenders = runtime
      .filter((f) => /credentials_?version|credentialsVersion|must_?change_?password|mustChangePassword/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the User entity, the JWT payload and the login/strategy files are free of them', () => {
    for (const file of ['user/user.entity.ts', 'auth/interfaces/jwt-payload.interface.ts', 'auth/auth.service.ts', 'auth/strategies/jwt.strategy.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/credentials_?version|credentialsVersion|mustChange|must_change/i);
    }
  });

  it('the migration is the only place that names them', () => {
    const migrations = sourceFiles(join(SRC, 'migrations')).filter((f) => /credentials_version/.test(readFileSync(f, 'utf8')));
    expect(migrations.map((f) => relative(SRC, f))).toEqual(['migrations/1790400000000-AddCredentialsSecurity.ts']);
  });
});
