import { Migration } from '@mikro-orm/migrations';

// Literal historical codes keep this migration independent of future enum changes.
const originalCodes = `'INVALID_AMOUNT','INVALID_CURRENCY','CURRENCY_MISMATCH','INVALID_WALLET_STATE',
  'INSUFFICIENT_BALANCE','REVERSAL_INSUFFICIENT_BALANCE','INVALID_LEDGER_ENTRY','INVALID_TRANSACTION',
  'INVALID_TRANSACTION_STATE','OPENING_INTERNAL_ONLY','REFERENCE_REQUIRED','REFERENCE_NOT_FOUND',
  'INVALID_REFERENCE','REFERENCE_AMOUNT_MISMATCH','DUPLICATE_REVERSAL','WALLET_MISMATCH','PAYLOAD_CONFLICT',
  'PERMANENT_INFRASTRUCTURE_FAILURE'`;

export class Migration20261005050000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wagering.wager_transactions drop constraint transactions_failure_check;
      alter table wagering.wager_transactions add constraint transactions_failure_check check (
        (status in ('REJECTED','FAILED')) = (failure_code is not null) and
        (failure_code is null or failure_code in (${originalCodes},'REFERENCE_NOT_PROCESSABLE','REVERSAL_INSUFFICIENT_FUNDS')));
      alter table wagering.wager_transactions add constraint transactions_job_identity_unique unique(id,wallet_id);
      create table wagering.pending_reference_jobs (
        transaction_id uuid primary key,
        wallet_id uuid not null,
        status text not null check(status in ('READY','CLAIMED','COMPLETED','EXPIRED')),
        attempts integer not null default 0 check(attempts >= 0),
        next_attempt_at timestamptz not null,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        updated_at timestamptz not null,
        completed_at timestamptz,
        lease_token uuid,
        lease_owner text,
        lease_until timestamptz,
        correlation_id text not null check(btrim(correlation_id) <> ''),
        causation_id text not null check(btrim(causation_id) <> ''),
        constraint pending_job_transaction_fk foreign key(transaction_id,wallet_id)
          references wagering.wager_transactions(id,wallet_id) on delete restrict,
        constraint pending_job_ttl_check check(expires_at=created_at+interval '15 minutes' and next_attempt_at<=expires_at),
        constraint pending_job_completion_check check((status in ('COMPLETED','EXPIRED'))=(completed_at is not null)),
        constraint pending_job_lease_check check(
          (status='CLAIMED' and lease_token is not null and lease_owner is not null and btrim(lease_owner)<>'' and lease_until is not null) or
          (status<>'CLAIMED' and lease_token is null and lease_owner is null and lease_until is null))
      );
      create index pending_jobs_due_idx on wagering.pending_reference_jobs(next_attempt_at,transaction_id) where status='READY';
      create index pending_jobs_lease_idx on wagering.pending_reference_jobs(lease_until,transaction_id) where status='CLAIMED';
      insert into wagering.pending_reference_jobs(transaction_id,wallet_id,status,next_attempt_at,created_at,expires_at,
        updated_at,correlation_id,causation_id)
      select t.id,t.wallet_id,'READY',least(clock_timestamp(),t.created_at+interval '15 minutes'),t.created_at,
        t.created_at+interval '15 minutes',clock_timestamp(),coalesce(o.payload->>'correlationId',t.id::text),
        coalesce(o.payload->>'causationId',t.id::text)
      from wagering.wager_transactions t left join wagering.outbox_events o on o.transaction_id=t.id
        and o.event_type='WagerTransactionPendingReference' where t.status='PENDING_REFERENCE';
    `);
  }
  override async down(): Promise<void> {
    // Downgrade fails safely if new failure codes are present; never delete audit history.
    this.addSql(`drop table wagering.pending_reference_jobs;
      alter table wagering.wager_transactions drop constraint transactions_job_identity_unique;
      alter table wagering.wager_transactions drop constraint transactions_failure_check;
      alter table wagering.wager_transactions add constraint transactions_failure_check check (
        (status in ('REJECTED','FAILED')) = (failure_code is not null) and
        (failure_code is null or failure_code in (${originalCodes})));`);
  }
}
