import { Migration } from '@mikro-orm/migrations';

export class Migration20261005020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wagering.wallets (
        id uuid primary key,
        player_id text not null check (btrim(player_id) <> ''),
        currency text not null check (currency ~ '^[A-Z]{3}$' and length(currency) = 3),
        balance numeric not null,
        version bigint not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_check check (balance >= 0 and balance < 'Infinity'::numeric and scale(balance) <= 2),
        constraint wallets_version_check check (version >= 1 and version <= 9007199254740991),
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_identity_unique unique (id, player_id, currency)
      );

      create table wagering.wager_transactions (
        id uuid primary key,
        provider_id text not null check (btrim(provider_id) <> ''),
        external_transaction_id text not null check (btrim(external_transaction_id) <> ''),
        idempotency_key text not null check (btrim(idempotency_key) <> ''),
        payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$' and length(payload_hash) = 64),
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null check (btrim(round_id) <> ''),
        game_id text not null check (btrim(game_id) <> ''),
        kind text not null,
        amount numeric not null,
        currency text not null,
        reference_external_transaction_id text,
        status text not null,
        reference_transaction_id uuid,
        failure_code text,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint transactions_kind_check check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint transactions_status_check check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint transactions_amount_check check (amount >= 0 and amount < 'Infinity'::numeric and scale(amount) <= 2),
        constraint transactions_opening_check check (
          (kind = 'OPENING') = (provider_id = 'internal') and
          (kind <> 'OPENING' or (amount > 0 and external_transaction_id = id::text and
            idempotency_key = 'opening:' || wallet_id::text and round_id = 'wallet-opening' and game_id = 'internal'))
        ),
        constraint transactions_reference_check check (
          (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null) and
          (reference_external_transaction_id is null or
            (kind in ('WIN','REFUND','ROLLBACK') and btrim(reference_external_transaction_id) <> '')) and
          (reference_transaction_id is null or
            (reference_transaction_id <> id and reference_external_transaction_id is not null and status = 'PROCESSED')) and
          (status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null) and
          (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null)
        ),
        constraint transactions_processed_at_check check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint transactions_failure_check check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null) and
          (failure_code is null or failure_code in (
            'INVALID_AMOUNT','INVALID_CURRENCY','CURRENCY_MISMATCH','INVALID_WALLET_STATE',
            'INSUFFICIENT_BALANCE','REVERSAL_INSUFFICIENT_BALANCE','INVALID_LEDGER_ENTRY',
            'INVALID_TRANSACTION','INVALID_TRANSACTION_STATE','OPENING_INTERNAL_ONLY','REFERENCE_REQUIRED',
            'REFERENCE_NOT_FOUND','INVALID_REFERENCE','REFERENCE_AMOUNT_MISMATCH','DUPLICATE_REVERSAL',
            'WALLET_MISMATCH','PAYLOAD_CONFLICT','PERMANENT_INFRASTRUCTURE_FAILURE'
          ))
        ),
        constraint transactions_idempotency_unique unique (idempotency_key),
        constraint transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint transactions_ledger_identity_unique unique (id, wallet_id, currency, amount, kind, status),
        constraint transactions_reference_identity_unique unique
          (id, provider_id, player_id, wallet_id, currency, round_id, external_transaction_id),
        constraint transactions_wallet_fk foreign key (wallet_id, player_id, currency)
          references wagering.wallets (id, player_id, currency) on delete restrict,
        constraint transactions_reference_fk foreign key
          (reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id, reference_external_transaction_id)
          references wagering.wager_transactions
          (id, provider_id, player_id, wallet_id, currency, round_id, external_transaction_id) on delete restrict
      );

      create table wagering.wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        transaction_kind text not null,
        transaction_status text not null,
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount numeric not null,
        currency text not null,
        balance_before numeric not null,
        balance_after numeric not null,
        created_at timestamptz not null,
        constraint ledger_amount_check check (amount > 0 and amount < 'Infinity'::numeric and scale(amount) <= 2),
        constraint ledger_before_check check (balance_before >= 0 and balance_before < 'Infinity'::numeric and scale(balance_before) <= 2),
        constraint ledger_after_check check (balance_after >= 0 and balance_after < 'Infinity'::numeric and scale(balance_after) <= 2),
        constraint ledger_arithmetic_check check (
          (direction = 'CREDIT' and balance_before + amount = balance_after) or
          (direction = 'DEBIT' and balance_before - amount = balance_after)
        ),
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        constraint ledger_processed_check check (transaction_status = 'PROCESSED'),
        constraint ledger_kind_direction_check check (
          (transaction_kind = 'BET' and direction = 'DEBIT') or
          (transaction_kind in ('OPENING','WIN','REFUND') and direction = 'CREDIT') or
          (transaction_kind = 'ROLLBACK' and direction in ('DEBIT','CREDIT'))
        ),
        constraint ledger_wallet_fk foreign key (wallet_id) references wagering.wallets (id) on delete restrict,
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency, amount, transaction_kind, transaction_status)
          references wagering.wager_transactions (id, wallet_id, currency, amount, kind, status) on delete restrict
      );

      create index transactions_wallet_history_idx on wagering.wager_transactions (wallet_id, created_at, id);
      create index transactions_reference_idx on wagering.wager_transactions (reference_transaction_id)
        where reference_transaction_id is not null;
      create unique index transactions_processed_reversal_unique on wagering.wager_transactions
        (reference_transaction_id, kind) where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
      create index transactions_pending_reference_idx on wagering.wager_transactions
        (provider_id, reference_external_transaction_id, created_at) where status = 'PENDING_REFERENCE';
      create index ledger_wallet_history_idx on wagering.wallet_ledger_entries (wallet_id, created_at, id);
      create index ledger_transaction_idx on wagering.wallet_ledger_entries (transaction_id);

      create function wagering.prevent_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger entries are immutable' using errcode = '55000';
      end;
      $$;
      create trigger ledger_immutable before update or delete on wagering.wallet_ledger_entries
        for each row execute function wagering.prevent_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    // Drop only objects introduced here, in FK dependency order; never CASCADE.
    this.addSql(`
      drop table wagering.wallet_ledger_entries;
      drop function wagering.prevent_ledger_mutation();
      drop table wagering.wager_transactions;
      drop table wagering.wallets;
    `);
  }
}
