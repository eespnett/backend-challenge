import { createHash } from 'node:crypto';
import { validateWagerRequest, requestText } from './wager-request';
import { InvalidWagerRequestError } from './processing-errors';

export class MessageProtocolError extends Error {
  constructor(readonly code: 'INVALID_ENVELOPE' | 'INVALID_PAYLOAD' | 'MESSAGE_ID_CONFLICT') { super(code); }
}
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Sort every object recursively; retain array order and exact decimal strings. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)]));
    return v;
  };
  return JSON.stringify(sort(value));
}
export function messageIdentity(raw: string, transportId: string): { messageId: string; hash: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { messageId: requestText(parsed?.messageId, 'messageId'), hash: sha256(canonicalJson(parsed)) };
  } catch { return { messageId: `transport:${transportId}`, hash: sha256(raw) }; }
}
export function validateWagerEnvelope(raw: string) {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    envelope = parsed as Record<string, unknown>;
    if (Object.keys(envelope).some((k) => !['messageId', 'type', 'occurredAt', 'data'].includes(k))) throw new Error();
    requestText(envelope.messageId, 'messageId');
    if (envelope.type !== 'WagerTransactionRequested' || typeof envelope.occurredAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(envelope.occurredAt) ||
      !Number.isFinite(Date.parse(envelope.occurredAt)) || new Date(envelope.occurredAt).toISOString() !== envelope.occurredAt) throw new Error();
  } catch { throw new MessageProtocolError('INVALID_ENVELOPE'); }
  try {
    if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new InvalidWagerRequestError('Invalid data');
    const { idempotencyKey, ...body } = envelope.data as Record<string, unknown>;
    const request = validateWagerRequest(body, idempotencyKey);
    // Reuse the HTTP contract; normalized business fields are exactly those hashed by HTTP.
    return { messageId: envelope.messageId as string, body,
      idempotencyKey: request.idempotencyKey };
  } catch { throw new MessageProtocolError('INVALID_PAYLOAD'); }
}
