import { Type } from '@mikro-orm/core';

/** PostgreSQL NUMERIC is returned as text; neither hydration nor comparison uses number. */
export function canonicalDecimal(value: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value) || value.trim() !== value) {
    throw new Error('Expected an exact decimal string with at most two fractional digits');
  }
  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return `${negative && cents !== 0n ? '-' : ''}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

// DecimalType's built-in equality converts strings to number; deliberately avoid it.
export class ExactMoneyType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string { return canonicalDecimal(value); }
  override convertToJSValue(value: string): string { return canonicalDecimal(value); }
  override compareValues(a: string, b: string): boolean { return canonicalDecimal(a) === canonicalDecimal(b); }
  override compareAsType(): string { return 'string'; }
  override getColumnType(): string { return 'numeric'; }
}
