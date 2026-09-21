import { MigrationInterface, QueryRunner } from "typeorm";

// Root cause: every timestamp column in this schema was plain "timestamp
// without time zone". Postgres itself stored the correct UTC wall-clock
// text (this connection's session timezone is UTC), but node-postgres
// hydrates a tz-less "timestamp" value into a JS Date using the *Node
// process's local time zone* instead of UTC — confirmed empirically by
// comparing the raw stored text against what TypeORM/pg handed back for
// the same row. That silently shifted every read timestamp by the host
// machine's UTC offset (this is what made "Sesión activa · desde HH:MM"
// show the wrong hour in Admin). "timestamp with time zone" (timestamptz)
// is unambiguous regardless of session/server time zone and is what
// node-postgres parses correctly.
//
// ALTER COLUMN ... TYPE timestamptz USING col AT TIME ZONE 'UTC' converts
// in place (no DROP+ADD, so existing rows and NOT NULL/defaults survive)
// and tells Postgres explicitly "the existing naive value already IS a UTC
// wall-clock" — which is true here — so no historical timestamp changes
// value, only its type/representation.
export class FixTimestampTimezones1789958545342 implements MigrationInterface {
    name = 'FixTimestampTimezones1789958545342'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "table_sessions" ALTER COLUMN "opened_at" TYPE timestamptz USING "opened_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ALTER COLUMN "closed_at" TYPE timestamptz USING "closed_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "businesses" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "businesses" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "businesses" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "businesses" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "table_sessions" ALTER COLUMN "closed_at" TYPE timestamp USING "closed_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ALTER COLUMN "opened_at" TYPE timestamp USING "opened_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "deleted_at" TYPE timestamp USING "deleted_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "restaurant_tables" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "deleted_at" TYPE timestamp USING "deleted_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "categories" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);

        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "deleted_at" TYPE timestamp USING "deleted_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "products" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`);
    }

}
