import type { LegacyRow, RowKind, RowRepository } from './types.js';

// Runs one parameterised statement and returns its rows (an UPDATE ...
// RETURNING returns the updated rows).
export type SqlExec = (sql: string, params: unknown[]) => Promise<unknown>;

// TypeORM's DataSource.query() returns [rows, affectedCount] for UPDATE ...
// RETURNING, a plain pg client returns rows; accept both.
function toRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number') {
    return raw[0] as Array<Record<string, unknown>>;
  }
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

const SELECT_PRODUCTS = `SELECT 'product' AS kind, id, business_id, image_url AS legacy_url,
  image_storage_key AS storage_key, (deleted_at IS NOT NULL) AS deleted FROM products`;
const SELECT_LOGOS = `SELECT 'logo' AS kind, id, id AS business_id, logo_url AS legacy_url,
  logo_storage_key AS storage_key, false AS deleted FROM businesses`;

function toLegacyRow(r: Record<string, unknown>): LegacyRow {
  return {
    kind: r.kind as RowKind,
    id: String(r.id),
    businessId: String(r.business_id),
    legacyUrl: (r.legacy_url as string | null) ?? null,
    storageKey: (r.storage_key as string | null) ?? null,
    deleted: r.deleted === true,
  };
}

// The ONLY write this migration can make to the database is
// setStorageKey(): one column, on one row, guarded by "no key yet and the
// legacy URL is still exactly the inventoried one". image_url / logo_url are
// never written.
export class SqlRowRepository implements RowRepository {
  constructor(private readonly exec: SqlExec) {}

  async listRows(): Promise<LegacyRow[]> {
    const products = toRows(await this.exec(`${SELECT_PRODUCTS} ORDER BY id`, []));
    const logos = toRows(await this.exec(`${SELECT_LOGOS} ORDER BY id`, []));
    return [...products, ...logos].map(toLegacyRow);
  }

  async fetchRow(kind: RowKind, id: string): Promise<LegacyRow | null> {
    const sql = kind === 'product' ? `${SELECT_PRODUCTS} WHERE id = $1` : `${SELECT_LOGOS} WHERE id = $1`;
    const rows = toRows(await this.exec(sql, [id]));
    return rows[0] ? toLegacyRow(rows[0]) : null;
  }

  async setStorageKey(kind: RowKind, id: string, key: string, expectedLegacyUrl: string): Promise<boolean> {
    const sql =
      kind === 'product'
        ? `UPDATE products SET image_storage_key = $1
             WHERE id = $2 AND image_storage_key IS NULL AND image_url = $3 AND deleted_at IS NULL
             RETURNING id`
        : `UPDATE businesses SET logo_storage_key = $1
             WHERE id = $2 AND logo_storage_key IS NULL AND logo_url = $3
             RETURNING id`;
    return toRows(await this.exec(sql, [key, id, expectedLegacyUrl])).length === 1;
  }
}
