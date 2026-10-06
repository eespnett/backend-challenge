import { BadRequestException } from '@nestjs/common';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface LedgerCursor { version: 1; walletId: string; createdAt: string; id: string }
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
export function decodeLedgerCursor(raw: unknown, walletId: string): LedgerCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error();
    const value = JSON.parse(bytes.toString('utf8')) as LedgerCursor;
    if (!value || Object.keys(value).sort().join(',') !== 'createdAt,id,version,walletId' || value.version !== 1 ||
      value.walletId !== walletId.toLowerCase() || typeof value.id !== 'string' || !uuidPattern.test(value.id) ||
      typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.createdAt) ||
      value.createdAt.startsWith('0000-')) throw new Error(); // PostgreSQL has no year zero.
    const millis = value.createdAt.replace(/(\.\d{3})\d{3}Z$/, '$1Z');
    if (!Number.isFinite(Date.parse(millis)) || new Date(millis).toISOString() !== millis) throw new Error();
    return value;
  } catch { throw new BadRequestException({ failureCode: 'INVALID_CURSOR', message: 'Invalid ledger cursor' }); }
}
export function ledgerLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) {
    throw new BadRequestException({ failureCode: 'INVALID_LIMIT', message: 'limit must be between 1 and 100' });
  }
  return Number(raw);
}
