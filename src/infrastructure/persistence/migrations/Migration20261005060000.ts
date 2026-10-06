import { Migration } from '@mikro-orm/migrations';

export class Migration20261005060000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table wagering.consumer_inbox (
      consumer_name text not null check(btrim(consumer_name)<>''),
      message_id text not null check(btrim(message_id)<>''),
      payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
      received_at timestamptz not null default clock_timestamp(),
      processed_at timestamptz,
      status text not null default 'RECEIVED' check(status in ('RECEIVED','PROCESSED','REJECTED')),
      result jsonb, error_code text,
      primary key(consumer_name,message_id),
      check ((status='RECEIVED' and processed_at is null and result is null and error_code is null) or
        (status='PROCESSED' and processed_at is not null and result is not null and error_code is null) or
        (status='REJECTED' and processed_at is not null and result is not null and error_code is not null))
    );
    create table wagering.consumer_dead_letters (
      consumer_name text not null,
      message_id text not null,
      payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
      original_body text not null,
      transport_message_id text not null,
      error_code text not null check(btrim(error_code)<>''),
      created_at timestamptz not null default clock_timestamp(),
      sent_at timestamptz,
      primary key(consumer_name,message_id,payload_hash)
    );
    create index inbox_processed_idx on wagering.consumer_inbox(processed_at) where status<>'RECEIVED';
    create function wagering.prevent_inbox_rewrite() returns trigger language plpgsql as $$ begin
      if old.consumer_name<>new.consumer_name or old.message_id<>new.message_id or old.payload_hash<>new.payload_hash
        or old.received_at<>new.received_at or old.status<>'RECEIVED' then
        raise exception 'Inbox identity/result is immutable' using errcode='55000';
      end if;
      return new;
    end; $$;
    create trigger inbox_immutable before update on wagering.consumer_inbox for each row execute function wagering.prevent_inbox_rewrite();`);
  }
  override async down(): Promise<void> {
    this.addSql(`drop table wagering.consumer_dead_letters; drop table wagering.consumer_inbox;
      drop function wagering.prevent_inbox_rewrite();`);
  }
}
