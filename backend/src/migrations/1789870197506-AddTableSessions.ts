import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTableSessions1789870197506 implements MigrationInterface {
    name = 'AddTableSessions1789870197506'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "table_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "table_id" uuid NOT NULL, "business_id" uuid NOT NULL, "session_token" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'OPEN', "opened_at" TIMESTAMP NOT NULL DEFAULT now(), "closed_at" TIMESTAMP, CONSTRAINT "UQ_b6d1631b7f6bbf02aa05cc8e567" UNIQUE ("session_token"), CONSTRAINT "PK_41bb063768931e959eb1f86daa3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_table_sessions_one_open_per_table" ON "table_sessions"  ("table_id") WHERE "status" = 'OPEN'`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD CONSTRAINT "FK_73328bc5dcedce124fa829375bb" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD CONSTRAINT "FK_717518e9f091421cd4deb53983a" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP CONSTRAINT "FK_717518e9f091421cd4deb53983a"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP CONSTRAINT "FK_73328bc5dcedce124fa829375bb"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_table_sessions_one_open_per_table"`);
        await queryRunner.query(`DROP TABLE "table_sessions"`);
    }

}
