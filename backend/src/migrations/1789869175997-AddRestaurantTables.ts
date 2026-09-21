import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRestaurantTables1789869175997 implements MigrationInterface {
    name = 'AddRestaurantTables1789869175997'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "restaurant_tables" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "business_id" uuid NOT NULL, "name" character varying NOT NULL, "active" boolean NOT NULL DEFAULT true, "qr_token" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "UQ_a1388ae556484166f22dd41fb35" UNIQUE ("qr_token"), CONSTRAINT "PK_2b4f4ef7ad8394abee2c1f4d57e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "restaurant_tables" ADD CONSTRAINT "FK_86d1f5f0e4e2658eeab325c6b52" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "restaurant_tables" DROP CONSTRAINT "FK_86d1f5f0e4e2658eeab325c6b52"`);
        await queryRunner.query(`DROP TABLE "restaurant_tables"`);
    }

}
