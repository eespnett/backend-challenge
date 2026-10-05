import { randomUUID } from 'node:crypto';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletLedgerEntry, LedgerDirection } from '../domain/wallet-ledger-entry';
import { WageringPolicy } from '../domain/wagering-policy';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected, IntegrationEvent } from '../domain/events';
import { TransactionManager, FinancialUnitOfWork } from './financial-unit-of-work';
import { RecordedSubmission, StoredProcessingResult } from './processing-result';
import { InfrastructureUnavailableError, InvalidWagerRequestError, ProcessingConflictError, SubmissionUniquenessCollision } from './processing-errors';
import { requestText, validateWagerRequest, wagerPayloadHash, ValidatedWagerRequest } from './wager-request';

export class ProcessWagerTransactionUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  async execute(body: unknown, key: unknown, context: { correlationId?: string; causationId?: string } = {}): Promise<StoredProcessingResult> {
    const request = validateWagerRequest(body, key);
    const hash = wagerPayloadHash(request);
    const correlationId = context.correlationId === undefined ? randomUUID() : requestText(context.correlationId, 'correlationId');
    const causationId = context.causationId === undefined ? undefined : requestText(context.causationId, 'causationId');
    // Creation validates required references before any wallet mutation.
    const transaction = WagerTransaction.create({ ...request, id: randomUUID(), payloadHash: hash, createdAt: new Date() });
    try {
      return await this.transactions.run(async (repositories) => {
        const existing = await this.resolveExisting(repositories, request, hash);
        if (existing !== undefined) return existing;
        const wallet = await repositories.wallets.lockById(request.walletId);
        if (wallet === undefined) throw new InvalidWagerRequestError('Wallet does not exist');
        // READ COMMITTED sees the prior lock holder's commit here, including duplicate submissions.
        const raced = await this.resolveExisting(repositories, request, hash);
        if (raced !== undefined) return raced;
        const reference = request.referenceExternalTransactionId === undefined ? undefined :
          await repositories.transactions.findByProviderAndExternalId(request.providerId, request.referenceExternalTransactionId);
        const reversals = reference === undefined || !transaction.requiresReference() ? [] :
          await repositories.transactions.findProcessedReversals(reference.id);
        const decision = WageringPolicy.evaluate(wallet, transaction, { reference, processedReversals: reversals });
        const at = new Date();
        const eventContext = () => ({ eventId: randomUUID(), correlationId, causationId: causationId ?? transaction.id, occurredAt: at });
        let entry: WalletLedgerEntry | undefined;
        let httpStatus: StoredProcessingResult['httpStatus'];
        const events: IntegrationEvent<unknown>[] = [];
        if (decision.outcome === 'PENDING_REFERENCE') {
          transaction.markPendingReference();
          httpStatus = 202;
          events.push(WagerTransactionPendingReference.from(transaction, eventContext()));
        } else if (decision.outcome === 'REJECT') {
          transaction.reject(decision.failureCode);
          httpStatus = 422;
          events.push(WagerTransactionRejected.from(transaction, eventContext()));
        } else {
          const movement = decision.direction === LedgerDirection.Debit ? wallet.debit(decision.money, at) :
            decision.direction === LedgerDirection.Credit ? wallet.credit(decision.money, at) : undefined;
          transaction.markProcessed(decision.referenceTransactionId, at);
          if (movement !== undefined) {
            await repositories.wallets.saveLocked(wallet);
            entry = WalletLedgerEntry.create({ ...movement, id: randomUUID(), transactionId: transaction.id, createdAt: at });
            events.push(WalletBalanceChanged.from(wallet, entry, eventContext()));
          }
          httpStatus = 200;
          events.push(WagerTransactionProcessed.from(transaction, wallet.balance, eventContext()));
        }
        const result: StoredProcessingResult = { httpStatus, body: { transactionId: transaction.id,
          status: transaction.status, balance: wallet.balance.toJSON(), idempotentReplay: false,
          ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }) } };
        await repositories.transactions.add(transaction, result);
        if (entry !== undefined) await repositories.ledger.append(entry);
        await repositories.outbox.enqueue(transaction.id, events);
        return result;
      });
    } catch (error) {
      if (!(error instanceof SubmissionUniquenessCollision)) throw error;
      // The entire losing SQL transaction has already rolled back, including wallet update.
      return this.transactions.run(async (repositories) => {
        const winner = await this.resolveExisting(repositories, request, hash);
        if (winner === undefined) throw new InfrastructureUnavailableError();
        return winner;
      });
    }
  }

  private replay(record: RecordedSubmission, hash: string): StoredProcessingResult {
    if (!record.transaction.matchesPayload(hash)) throw new ProcessingConflictError('IDEMPOTENCY_CONFLICT');
    if (record.result === undefined) throw new InfrastructureUnavailableError();
    // Only persisted response data: no wallet read and no new events on replay.
    return { httpStatus: record.result.httpStatus, body: { ...structuredClone(record.result.body), idempotentReplay: true } };
  }

  private async resolveExisting(repositories: FinancialUnitOfWork, request: ValidatedWagerRequest, hash: string): Promise<StoredProcessingResult | undefined> {
    const record = await repositories.transactions.findSubmissionByIdempotencyKey(request.idempotencyKey);
    if (record !== undefined) return this.replay(record, hash);
    const external = await repositories.transactions.findByProviderAndExternalId(request.providerId, request.externalTransactionId);
    if (external !== undefined) throw new ProcessingConflictError('EXTERNAL_TRANSACTION_CONFLICT');
    return undefined;
  }
}
