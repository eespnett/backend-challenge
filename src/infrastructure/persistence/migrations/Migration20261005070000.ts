import { Migration } from '@mikro-orm/migrations';

export class Migration20261005070000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wagering.outbox_events
      add column attempts integer not null default 0 check(attempts>=0),
      add column last_attempt_at timestamptz,
      add column next_attempt_at timestamptz not null default clock_timestamp(),
      add column last_error text,
      add column lease_token uuid,
      add column lease_owner text,
      add column lease_until timestamptz,
      add constraint outbox_lease_check check(
        (lease_token is null and lease_owner is null and lease_until is null) or
        (published_at is null and lease_token is not null and lease_owner is not null and btrim(lease_owner)<>'' and lease_until is not null));
      create index outbox_due_idx on wagering.outbox_events(next_attempt_at,created_at,id) where published_at is null;
      create function wagering.prevent_outbox_rewrite() returns trigger language plpgsql as $$ begin
        if tg_op='DELETE' then raise exception 'Outbox audit cannot be deleted' using errcode='55000';end if;
        if new.id is distinct from old.id or new.transaction_id is distinct from old.transaction_id
          or new.aggregate_id is distinct from old.aggregate_id or new.event_type is distinct from old.event_type
          or new.version is distinct from old.version or new.payload is distinct from old.payload
          or new.occurred_at is distinct from old.occurred_at or new.created_at is distinct from old.created_at
          or (old.published_at is not null and new.published_at is distinct from old.published_at) then
          raise exception 'Outbox identity/content/publication is immutable' using errcode='55000';
        end if; return new;
      end;$$;
      create trigger outbox_immutable before update or delete on wagering.outbox_events
        for each row execute function wagering.prevent_outbox_rewrite();
      create table wagering.integration_event_receipts (
        consumer_name text not null check(btrim(consumer_name)<>''),
        event_id uuid not null,
        payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
        event_type text not null,
        payload jsonb not null,
        consumed_at timestamptz not null default clock_timestamp(),
        primary key(consumer_name,event_id),
        check(coalesce(jsonb_typeof(payload)='object' and payload @> jsonb_build_object('eventId',event_id::text,'eventType',event_type),false))
      );
      create function wagering.prevent_event_receipt_mutation() returns trigger language plpgsql as $$ begin
        raise exception 'Event receipt is immutable' using errcode='55000';end;$$;
      create trigger event_receipt_immutable before update or delete on wagering.integration_event_receipts
        for each row execute function wagering.prevent_event_receipt_mutation();`);
  }
  override async down(): Promise<void> {
    this.addSql(`drop table wagering.integration_event_receipts;drop function wagering.prevent_event_receipt_mutation();
      drop trigger outbox_immutable on wagering.outbox_events;drop function wagering.prevent_outbox_rewrite();
      drop index wagering.outbox_due_idx;
      alter table wagering.outbox_events drop constraint outbox_lease_check,
        drop column attempts,drop column last_attempt_at,drop column next_attempt_at,drop column last_error,
        drop column lease_token,drop column lease_owner,drop column lease_until;`);
  }
}
