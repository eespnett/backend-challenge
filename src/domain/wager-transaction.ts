import { DomainError, InvalidTransactionStateError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';
import { assertIdentifier, copyDate } from './validation';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED',
  Rejected = 'REJECTED', Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class WagerTransaction {
  private readonly props: Readonly<Omit<CreateWagerTransactionProps, 'createdAt'>>;
  private readonly timestamp: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private appliedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    for (const value of [state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId]) {
      assertIdentifier(value, FailureCode.InvalidTransaction);
    }
    if (!Object.values(WagerTransactionKind).includes(state.kind) || state.money.isNegative() ||
        !Object.values(WagerTransactionStatus).includes(state.status)) {
      throw new DomainError(FailureCode.InvalidTransaction, 'Invalid transaction kind, money or status');
    }
    if (state.referenceExternalTransactionId !== undefined) {
      assertIdentifier(state.referenceExternalTransactionId, FailureCode.InvalidReference);
    }
    if ([WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(state.kind) &&
        state.referenceExternalTransactionId === undefined) {
      throw new DomainError(FailureCode.ReferenceRequired, 'Reversal requires an external reference');
    }
    if (state.referenceExternalTransactionId !== undefined &&
        ![WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(state.kind)) {
      throw new DomainError(FailureCode.InvalidReference, 'This transaction kind cannot reference another operation');
    }
    if (state.referenceTransactionId !== undefined) {
      assertIdentifier(state.referenceTransactionId, FailureCode.InvalidReference);
    }
    const failed = [WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(state.status);
    const processed = state.status === WagerTransactionStatus.Processed;
    if (failed !== (state.failureCode !== undefined) ||
        (state.failureCode !== undefined && !Object.values(FailureCode).includes(state.failureCode)) ||
        processed !== (state.processedAt !== undefined) ||
        (state.status === WagerTransactionStatus.PendingReference && state.referenceExternalTransactionId === undefined) ||
        (processed && state.referenceExternalTransactionId !== undefined && state.referenceTransactionId === undefined) ||
        (state.referenceTransactionId !== undefined && (!processed || state.referenceExternalTransactionId === undefined))) {
      throw new DomainError(FailureCode.InvalidTransactionState, 'Persisted transaction state is inconsistent');
    }
    const { createdAt, status, referenceTransactionId, failureCode, processedAt, ...props } = state;
    this.props = Object.freeze(props);
    this.timestamp = copyDate(createdAt, FailureCode.InvalidTransaction);
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this.appliedAt = processedAt === undefined ? undefined : copyDate(processedAt, FailureCode.InvalidTransaction);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError(FailureCode.OpeningInternalOnly, 'OPENING is reserved for wallet creation');
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  static createOpening(props: {
    id: string; walletId: string; playerId: string; money: Money; payloadHash: string; createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) throw new DomainError(FailureCode.InvalidAmount, 'OPENING must be positive');
    return new WagerTransaction({ ...props, providerId: 'internal', externalTransactionId: props.id,
      idempotencyKey: `opening:${props.walletId}`, roundId: 'wallet-opening', gameId: 'internal',
      kind: WagerTransactionKind.Opening, status: WagerTransactionStatus.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }
  get id(): string { return this.props.id; }
  get providerId(): string { return this.props.providerId; }
  get externalTransactionId(): string { return this.props.externalTransactionId; }
  get idempotencyKey(): string { return this.props.idempotencyKey; }
  get payloadHash(): string { return this.props.payloadHash; }
  get walletId(): string { return this.props.walletId; }
  get playerId(): string { return this.props.playerId; }
  get roundId(): string { return this.props.roundId; }
  get gameId(): string { return this.props.gameId; }
  get kind(): WagerTransactionKind { return this.props.kind; }
  get money(): Money { return this.props.money; }
  get referenceExternalTransactionId(): string | undefined { return this.props.referenceExternalTransactionId; }
  get createdAt(): Date { return new Date(this.timestamp.getTime()); }
  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this.appliedAt === undefined ? undefined : new Date(this.appliedAt.getTime()); }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if ((this.referenceExternalTransactionId !== undefined) !== (referenceTransactionId !== undefined)) {
      throw new DomainError(FailureCode.InvalidReference, 'Resolved reference does not match the contract');
    }
    if (referenceTransactionId !== undefined) assertIdentifier(referenceTransactionId, FailureCode.InvalidReference);
    const timestamp = copyDate(at, FailureCode.InvalidTransactionState);
    this._referenceTransactionId = referenceTransactionId;
    this.appliedAt = timestamp;
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (this.referenceExternalTransactionId === undefined) throw new InvalidTransactionStateError();
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void { this.terminate(WagerTransactionStatus.Rejected, code); }
  fail(code: FailureCode): void { this.terminate(WagerTransactionStatus.Failed, code); }

  private terminate(status: WagerTransactionStatus, code: FailureCode): void {
    this.assertMutable();
    if (!Object.values(FailureCode).includes(code)) {
      throw new DomainError(FailureCode.InvalidTransactionState, 'Unknown failure code');
    }
    this._failureCode = code;
    this._status = status;
  }

  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]
      .includes(this._status);
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss && !this.money.isZero(); }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Loss) return undefined;
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind !== WagerTransactionKind.Rollback) return LedgerDirection.Credit;
    if (reference === undefined || ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
      .includes(reference.kind)) {
      throw new DomainError(FailureCode.InvalidReference, 'ROLLBACK requires a reversible reference');
    }
    return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
  }

  private assertMutable(): void { if (this.isTerminal()) throw new InvalidTransactionStateError(); }
}
