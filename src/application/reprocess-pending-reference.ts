import { randomUUID } from 'node:crypto';
import { TransactionManager } from './financial-unit-of-work';
import { PendingReferenceClaim } from './pending-reference-ports';
import { pendingReferenceNextAttempt } from './pending-reference-schedule';
import { WageringPolicy } from '../domain/wagering-policy';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus as Status } from '../domain/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/events';

export type PendingReferenceOutcome = 'STALE' | 'WAITING' | 'PROCESSED' | 'REJECTED' | 'EXPIRED';

export class ReprocessPendingReferenceUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute(claim: PendingReferenceClaim): Promise<PendingReferenceOutcome> {
    return this.transactions.run(async (uow) => {
      // Wallet first: a worker waiting here cannot retain a job row lock after lease expiry.
      const wallet = await uow.wallets.lockById(claim.walletId);
      if (wallet === undefined) throw new Error('Pending reference wallet is missing');
      const job = await uow.pendingReferences.lockOwned(claim);
      if (job === undefined) return 'STALE';
      const tx = await uow.transactions.findById(claim.transactionId);
      if (tx === undefined || tx.walletId !== wallet.id) throw new Error('Invalid pending reference identity');
      if (tx.status !== Status.PendingReference) {
        await uow.pendingReferences.finish(job, false);
        return 'STALE';
      }
      const reference = await uow.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const reversals = reference === undefined || !tx.requiresReference() ? [] : await uow.transactions.findProcessedReversals(reference.id);
      const expired = job.now.getTime() >= job.expiresAt.getTime();
      const decision = expired ? { outcome: 'REJECT' as const,
        failureCode: reference === undefined ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessable } :
        WageringPolicy.evaluate(wallet, tx, { reference, processedReversals: reversals });
      if (decision.outcome === 'PENDING_REFERENCE') {
        await uow.pendingReferences.retry(job, pendingReferenceNextAttempt(job.now, job.expiresAt, job.attempts));
        return 'WAITING';
      }
      const context = () => ({ eventId: randomUUID(), correlationId: job.correlationId,
        causationId: job.causationId, occurredAt: job.now });
      const events: IntegrationEvent<unknown>[] = [];
      let ledger: WalletLedgerEntry | undefined;
      if (decision.outcome === 'REJECT') {
        tx.reject(decision.failureCode);
        events.push(WagerTransactionRejected.from(tx, context()));
      } else {
        const movement = decision.direction === LedgerDirection.Debit ? wallet.debit(decision.money, job.now) :
          decision.direction === LedgerDirection.Credit ? wallet.credit(decision.money, job.now) : undefined;
        tx.markProcessed(decision.referenceTransactionId, job.now);
        if (movement !== undefined) {
          await uow.wallets.saveLocked(wallet);
          ledger = WalletLedgerEntry.create({ ...movement, id: randomUUID(), transactionId: tx.id, createdAt: job.now });
          events.push(WalletBalanceChanged.from(wallet, ledger, context()));
        }
        events.push(WagerTransactionProcessed.from(tx, wallet.balance, context()));
      }
      // Updating current state intentionally never changes the original HTTP 202 snapshot.
      await uow.transactions.saveState(tx);
      if (ledger !== undefined) await uow.ledger.append(ledger);
      await uow.outbox.enqueue(tx.id, events);
      await uow.pendingReferences.finish(job, expired);
      return expired ? 'EXPIRED' : decision.outcome === 'REJECT' ? 'REJECTED' : 'PROCESSED';
    });
  }
}
