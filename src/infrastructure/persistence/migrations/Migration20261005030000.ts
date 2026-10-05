import { Migration } from '@mikro-orm/migrations';

export class Migration20261005030000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wagering.wager_transactions
        add column result_http_status smallint,
        add column result_body jsonb,
        add constraint transactions_result_check check (
          (result_http_status is null and result_body is null) or
          coalesce((result_http_status is not null and result_body is not null and
            result_http_status in (200,202,422) and jsonb_typeof(result_body) = 'object' and
            result_body @> jsonb_build_object('transactionId', id::text, 'idempotentReplay', false) and
            coalesce(result_body->>'status', '') = case result_http_status
              when 200 then 'PROCESSED' when 202 then 'PENDING_REFERENCE' when 422 then 'REJECTED' end and
            jsonb_typeof(result_body->'balance') = 'object' and
            jsonb_typeof(result_body->'balance'->'amount') = 'string' and
            coalesce(result_body->'balance'->>'amount', '') ~ '^(0|[1-9][0-9]*)\\.[0-9]{2}$' and
            coalesce(result_body->'balance'->>'currency', '') ~ '^[A-Z]{3}$' and
            ((result_http_status = 422 and jsonb_typeof(result_body->'failureCode') = 'string') or
              (result_http_status <> 422 and not result_body ? 'failureCode'))), false)
        ),
        add constraint transactions_player_check check (btrim(player_id) <> ''),
        add constraint transactions_currency_check check (currency ~ '^[A-Z]{3}$' and length(currency)=3);

      -- Rejected identity/currency mismatches must remain auditable. Other statuses
      -- retain the composite identity FK; every status still requires an existing wallet.
      alter table wagering.wager_transactions drop constraint transactions_wallet_fk;
      alter table wagering.wager_transactions
        add column validated_player_id text generated always as
          (case when status = 'REJECTED' then null else player_id end) stored,
        add column validated_currency text generated always as
          (case when status = 'REJECTED' then null else currency end) stored,
        add constraint transactions_wallet_exists_fk foreign key (wallet_id)
          references wagering.wallets(id) on delete restrict,
        add constraint transactions_wallet_fk foreign key (wallet_id, validated_player_id, validated_currency)
          references wagering.wallets(id, player_id, currency) on delete restrict;

      -- Preserve the original response even when a future phase resolves a pending reference.
      create function wagering.prevent_result_mutation() returns trigger language plpgsql as $$
      begin
        if old.result_http_status is not null and
          (new.result_http_status is distinct from old.result_http_status or new.result_body is distinct from old.result_body) then
          raise exception 'Original processing result is immutable' using errcode = '55000';
        end if;
        return new;
      end;
      $$;
      create trigger transaction_result_immutable before update on wagering.wager_transactions
        for each row execute function wagering.prevent_result_mutation();

      create table wagering.outbox_events (
        id uuid primary key,
        transaction_id uuid not null references wagering.wager_transactions(id) on delete restrict,
        aggregate_id uuid not null,
        event_type text not null check (event_type in ('WagerTransactionProcessed','WagerTransactionRejected',
          'WalletBalanceChanged','WagerTransactionPendingReference')),
        version integer not null check (version = 1),
        payload jsonb not null,
        occurred_at timestamptz not null,
        created_at timestamptz not null default now(),
        published_at timestamptz,
        constraint outbox_transaction_type_unique unique (transaction_id, event_type),
        constraint outbox_envelope_check check (coalesce(jsonb_typeof(payload) = 'object' and
          payload @> jsonb_build_object('eventId',id::text,'eventType',event_type,'version',version,
            'aggregateId',aggregate_id::text) and
          jsonb_typeof(payload->'data') = 'object' and
          payload->'data' @> jsonb_build_object('transactionId',transaction_id::text), false))
      );
      create index outbox_pending_idx on wagering.outbox_events(created_at,id) where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    // Restoring Phase 2 fails safely if rejected mismatching identities now exist.
    // No rows are silently discarded to make a destructive downgrade succeed.
    this.addSql(`
      drop table wagering.outbox_events;
      drop trigger transaction_result_immutable on wagering.wager_transactions;
      drop function wagering.prevent_result_mutation();
      alter table wagering.wager_transactions
        drop constraint transactions_wallet_fk,
        drop constraint transactions_wallet_exists_fk,
        drop column validated_player_id,
        drop column validated_currency,
        drop constraint transactions_player_check,
        drop constraint transactions_currency_check,
        drop constraint transactions_result_check,
        drop column result_http_status,
        drop column result_body,
        add constraint transactions_wallet_fk foreign key (wallet_id,player_id,currency)
          references wagering.wallets(id,player_id,currency) on delete restrict;
    `);
  }
}
