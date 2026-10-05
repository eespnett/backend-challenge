import { Migration } from '@mikro-orm/migrations';

export class Migration20261005000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create schema if not exists "wagering";');
  }

  override async down(): Promise<void> {
    // No CASCADE: refuse to remove the namespace if later tables still exist.
    this.addSql('drop schema "wagering";');
  }
}
