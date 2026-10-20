import type { DataSource } from 'typeorm';
import type { Business } from '../../src/business/business.entity.js';

// For suites that migrate to an EARLIER schema state (runMigrationsBefore) and then need a business: the repository
// would write/return every column the CURRENT entity knows, including ones a later migration adds, and fail on that
// older schema. A plain INSERT of the two always-present columns works at every state; the other columns take their
// defaults. Only the id is returned (that is all those suites read).
export async function seedBusinessAtSchemaState(dataSource: DataSource, name: string, slug: string): Promise<Business> {
  const [row] = (await dataSource.query(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [name, slug])) as Array<{ id: string }>;
  return { id: row.id, name, slug } as Business;
}
