import { InvalidTransactionStateError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-transaction';

export type WageringDecision =
  | { readonly outcome: 'APPLY'; readonly direction: LedgerDirection | undefined; readonly money: Money;
      readonly referenceTransactionId: string | undefined }
  | { readonly outcome: 'PENDING_REFERENCE' }
  | { readonly outcome: 'REJECT'; readonly failureCode: FailureCode };

export interface WageringContext {
  readonly reference?: WagerTransaction;
  /** Application must load already PROCESSED reversals under its DB concurrency control. */
  readonly processedReversals?: readonly WagerTransaction[];
}

/** Business decisions only: no mutation, persistence, transport or idempotency store. */
export class WageringPolicy {
  static evaluate(wallet: Wallet, transaction: WagerTransaction, context: WageringContext = {}): WageringDecision {
    if (transaction.isTerminal()) throw new InvalidTransactionStateError();
    const reject = (failureCode: FailureCode): WageringDecision => Object.freeze({ outcome: 'REJECT', failureCode });
    if (transaction.kind === Kind.Opening) return reject(FailureCode.OpeningInternalOnly);
    if (wallet.id !== transaction.walletId || wallet.playerId !== transaction.playerId) {
      return reject(FailureCode.WalletMismatch);
    }
    if (wallet.currency !== transaction.money.currency) return reject(FailureCode.CurrencyMismatch);
    const reference = context.reference;
    if (transaction.referenceExternalTransactionId !== undefined) {
      if (reference === undefined) return Object.freeze({ outcome: 'PENDING_REFERENCE' });
      if (reference.id === transaction.id || reference.providerId !== transaction.providerId ||
          reference.externalTransactionId !== transaction.referenceExternalTransactionId ||
          reference.walletId !== transaction.walletId || reference.playerId !== transaction.playerId ||
          reference.roundId !== transaction.roundId) {
        return reject(FailureCode.InvalidReference);
      }
      if (reference.money.currency !== transaction.money.currency) return reject(FailureCode.CurrencyMismatch);
      const allowedKinds = transaction.kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund] : [Kind.Bet];
      if (!allowedKinds.includes(reference.kind)) return reject(FailureCode.InvalidReference);
      if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
        return Object.freeze({ outcome: 'PENDING_REFERENCE' });
      }
      if (reference.status !== Status.Processed) return reject(FailureCode.InvalidReference);
      if (transaction.requiresReference()) {
        if (!transaction.money.equals(reference.money)) return reject(FailureCode.ReferenceAmountMismatch);
        if ((context.processedReversals ?? []).some((reversal) =>
          reversal.status === Status.Processed && reversal.kind === transaction.kind &&
          reversal.referenceTransactionId === reference.id)) {
          return reject(FailureCode.DuplicateReversal);
        }
      }
    } else if (reference !== undefined) {
      return reject(FailureCode.InvalidReference);
    }
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
      return reject(transaction.kind === Kind.Rollback
        ? FailureCode.ReversalInsufficientBalance : FailureCode.InsufficientBalance);
    }
    return Object.freeze({ outcome: 'APPLY', direction: transaction.affectsBalance() ? direction : undefined,
      money: transaction.money, referenceTransactionId: reference?.id });
  }
}
