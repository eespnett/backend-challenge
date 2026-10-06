import { ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, SendMessageCommand } from '@aws-sdk/client-sqs';
import { TransactionManager } from '../../application/financial-unit-of-work';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction';
import { InvalidWagerRequestError, ProcessingConflictError, SubmissionUniquenessCollision } from '../../application/processing-errors';
import { messageIdentity, MessageProtocolError, sha256, validateWagerEnvelope } from '../../application/wager-envelope';
import { WAGER_CONSUMER } from '../../application/inbox-ports';
import { DomainError } from '../../domain/domain-error';
import { SqsService } from '../sqs/sqs.service';
import { silentTelemetry, TelemetryPort, TraceContext } from '../../application/telemetry-port';
import { StoredProcessingResult } from '../../application/processing-result';

export const SQS_VISIBILITY_SECONDS = 30;
export const SQS_MAX_RECEIVE_COUNT = 5;
export function retryVisibility(receiveCount: number): number { return Math.min(30, 2 ** Math.min(5, Math.max(0, receiveCount - 1))); }
export type DeliveryOutcome = 'ACK' | 'DLQ' | 'RETRY' | 'ABANDONED';

export class WagerConsumer {
  constructor(private readonly transactions: TransactionManager, private readonly process: ProcessWagerTransactionUseCase,
    private readonly sqs: SqsService, private readonly telemetry: TelemetryPort = silentTelemetry) {}

  async handle(message: Message, queueUrl: string, dlqUrl: string, signal: AbortSignal = new AbortController().signal): Promise<DeliveryOutcome> {
    const receipt = message.ReceiptHandle;
    const transportId = message.MessageId;
    if (!receipt || !transportId) throw new Error('SQS delivery has no identity/receipt');
    const raw = message.Body ?? '';
    const identity = messageIdentity(raw, transportId);
    const started = performance.now();
    const trace: TraceContext = { messageId: identity.messageId, correlationId: identity.messageId };
    const checkStopped = () => { if (signal.aborted) throw new Error('Delivery shutdown deadline exceeded'); };
    let renewing: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (signal.aborted || renewing) return;
      renewing = this.sqs.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl,
        ReceiptHandle: receipt, VisibilityTimeout: SQS_VISIBILITY_SECONDS }), { abortSignal: signal })
        .catch(() => undefined).finally(() => { renewing = undefined; });
    }, 10000);
    timer.unref();
    const abortRenewal = () => clearInterval(timer);
    signal.addEventListener('abort', abortRenewal, { once: true });
    try {
      let permanent: string | undefined;
      try {
        const envelope = validateWagerEnvelope(raw);
        Object.assign(trace, { walletId: envelope.body.walletId, providerId: envelope.body.providerId });
        // A uniqueness loser rolls back inbox AND financial state, then starts fresh.
        for (let attempt = 0; ; attempt++) {
          let committed: StoredProcessingResult | undefined;
          let inboxReplay = false;
          try {
            await this.transactions.run(async (uow) => {
              checkStopped();
              const record = await uow.inbox.reserve(identity.messageId, identity.hash);
              if (record.payloadHash !== identity.hash) throw new MessageProtocolError('MESSAGE_ID_CONFLICT');
              if (record.status !== 'RECEIVED') {
                inboxReplay = true;
                if (record.result && 'body' in record.result) committed = { ...record.result,
                  body: { ...record.result.body, idempotentReplay: true } };
                const code = record.result && 'errorCode' in record.result ? record.result.errorCode : undefined;
                if (code === 'INVALID_ENVELOPE' || code === 'INVALID_PAYLOAD' || code === 'MESSAGE_ID_CONFLICT') throw new MessageProtocolError(code);
                return;
              }
              try {
                const result = await this.process.executeInTransaction(uow, envelope.body, envelope.idempotencyKey,
                  { correlationId: identity.messageId, causationId: identity.messageId });
                await uow.inbox.finish(identity.messageId, identity.hash, result);
                committed = result;
              } catch (error) {
                // Persisted business/identity conflicts need no transport retry or duplicate financial effects.
                if (!(error instanceof ProcessingConflictError)) throw error;
                await uow.inbox.reject(identity.messageId, identity.hash, error.code);
              }
              checkStopped();
            });
            if (committed) {
              trace.transactionId = committed.body.transactionId;
              this.process.recordCommitted(committed, trace, 'sqs');
            } else if (inboxReplay) this.telemetry.increment('duplicates_detected', 'sqs');
            break;
          } catch (error) {
            if (!(error instanceof SubmissionUniquenessCollision) || attempt >= 1) throw error;
          }
        }
      } catch (error) {
        if (error instanceof MessageProtocolError) permanent = error.code;
        else if (error instanceof InvalidWagerRequestError || error instanceof DomainError) permanent = 'INVALID_PAYLOAD';
        else throw error;
      }
      checkStopped();
      if (permanent !== undefined) {
        const deadLetter = await this.transactions.run(async (uow) => {
          const record = await uow.inbox.reserve(identity.messageId, identity.hash);
          // Conflict deliveries cannot overwrite the original inbox hash or result.
          if (record.payloadHash === identity.hash && record.status === 'RECEIVED') {
            await uow.inbox.reject(identity.messageId, identity.hash, permanent!);
          }
          const result = await uow.inbox.deadLetter(identity.messageId, identity.hash, raw, transportId, permanent!);
          checkStopped();
          return result;
        });
        if (!deadLetter.sent) {
          const sent = await this.sqs.client.send(new SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: raw,
            MessageGroupId: message.Attributes?.MessageGroupId ?? WAGER_CONSUMER,
            MessageDeduplicationId: sha256(`${WAGER_CONSUMER}\n${identity.messageId}\n${identity.hash}`),
            MessageAttributes: { OriginalMessageId: { DataType: 'String', StringValue: identity.messageId },
              OriginalSqsMessageId: { DataType: 'String', StringValue: transportId },
              FailureCode: { DataType: 'String', StringValue: permanent },
              ConsumerName: { DataType: 'String', StringValue: WAGER_CONSUMER } } }), { abortSignal: signal });
          if (!sent.MessageId) throw new Error('DLQ send was not confirmed');
          checkStopped();
          await this.transactions.run(async (uow) => { await uow.inbox.markDeadLetterSent(identity.messageId, identity.hash); checkStopped(); });
          this.telemetry.log('warn', 'message_sent_to_dlq', trace);
        }
      }
      // No SQL transaction remains open here; every durable effect already committed.
      checkStopped();
      clearInterval(timer);
      await renewing;
      checkStopped();
      await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }), { abortSignal: signal });
      return permanent === undefined ? 'ACK' : 'DLQ';
    } catch {
      clearInterval(timer);
      await renewing;
      if (signal.aborted) return 'ABANDONED';
      this.telemetry.increment('retries_total', 'sqs');
      this.telemetry.log('warn', 'message_retry', trace);
      const receives = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      try {
        await this.sqs.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt,
          VisibilityTimeout: retryVisibility(Number.isFinite(receives) ? receives : 1) }), { abortSignal: signal });
      } catch { /* No delete: SQS's existing visibility/redrive still protects the delivery. */ }
      // At receive #5 we still do not delete/forward: native redrive owns exhausted retry.
      return 'RETRY';
    } finally {
      clearInterval(timer);
      signal.removeEventListener('abort', abortRenewal);
      await renewing;
      this.telemetry.latency((performance.now() - started) / 1000, 'sqs');
    }
  }
}
