import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { PendingReferenceClaim, PendingReferenceClaimStore, PendingReferenceRepository, OwnedPendingReference } from '../../application/pending-reference-ports';
import { PENDING_REFERENCE_TTL_MS, pendingReferenceBackoffMs } from '../../application/pending-reference-schedule';

interface JobRow {
  transaction_id: string; wallet_id: string; lease_token: string; attempts: number;
  expires_at: Date; observed_at: Date; correlation_id: string; causation_id: string;
}

export class MikroOrmPendingReferenceRepository implements PendingReferenceRepository {
  constructor(private readonly em: EntityManager) {}
  async schedule(transactionId: string, walletId: string, correlationId: string, causationId: string): Promise<void> {
    await this.em.execute(`with time as (select statement_timestamp() as now)
      insert into wagering.pending_reference_jobs(transaction_id,wallet_id,status,attempts,next_attempt_at,
        created_at,expires_at,updated_at,correlation_id,causation_id)
      select ?,?,'READY',0,now+?*interval '1 millisecond',now,now+?*interval '1 millisecond',now,?,? from time`,
      [transactionId,walletId,pendingReferenceBackoffMs(0),PENDING_REFERENCE_TTL_MS,correlationId,causationId]);
  }
  async lockOwned(claim: PendingReferenceClaim): Promise<OwnedPendingReference | undefined> {
    const rows = await this.em.execute<JobRow[]>(`select *,clock_timestamp() as observed_at from wagering.pending_reference_jobs
      where transaction_id=? and wallet_id=? and status='CLAIMED' and lease_token=? and lease_until>clock_timestamp() for update`,
      [claim.transactionId,claim.walletId,claim.leaseToken]);
    const row = rows[0];
    return row === undefined ? undefined : { ...claim, attempts: row.attempts, expiresAt: new Date(row.expires_at),
      now: new Date(row.observed_at), correlationId: row.correlation_id, causationId: row.causation_id };
  }
  async retry(job: OwnedPendingReference, nextAttemptAt: Date): Promise<void> {
    await this.update(job, `status='READY',next_attempt_at=?,lease_token=null,lease_owner=null,lease_until=null,
      updated_at=clock_timestamp()`, [nextAttemptAt]);
  }
  async finish(job: OwnedPendingReference, expired: boolean): Promise<void> {
    await this.update(job, `status=?,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_token=null,lease_owner=null,lease_until=null`, [expired ? 'EXPIRED' : 'COMPLETED']);
  }
  private async update(job: OwnedPendingReference, assignment: string, parameters: unknown[]) {
    const rows = await this.em.execute(`update wagering.pending_reference_jobs set ${assignment}
      where transaction_id=? and status='CLAIMED' and lease_token=? returning transaction_id`,
      [...parameters,job.transactionId,job.leaseToken]);
    if (rows.length !== 1) throw new Error('Pending reference lease ownership lost');
  }
}

export class MikroOrmPendingReferenceClaimStore implements PendingReferenceClaimStore {
  constructor(private readonly orm: MikroORM) {}
  async claim(workerId: string, limit: number, leaseMs: number): Promise<readonly PendingReferenceClaim[]> {
    if (!workerId.trim() || !Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(leaseMs) || leaseMs<1 || leaseMs>300000) {
      throw new Error('Invalid pending reference claim options');
    }
    return this.orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
      const rows = await em.execute<JobRow[]>(`with due as (
        select transaction_id from wagering.pending_reference_jobs where
          (status='READY' and next_attempt_at<=statement_timestamp()) or
          (status='CLAIMED' and lease_until<=statement_timestamp())
        order by next_attempt_at,transaction_id for update skip locked limit ?)
        update wagering.pending_reference_jobs j set status='CLAIMED',attempts=j.attempts+1,
          lease_token=gen_random_uuid(),lease_owner=?,lease_until=statement_timestamp()+?*interval '1 millisecond',
          updated_at=statement_timestamp() from due where j.transaction_id=due.transaction_id returning j.*`, [limit,workerId,leaseMs]);
      return rows.map((row) => ({ transactionId: row.transaction_id, walletId: row.wallet_id, leaseToken: row.lease_token }));
    });
  }
}
