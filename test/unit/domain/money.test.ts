import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { FailureCode } from '../../../src/domain/failure-code';
import { expectCode, money } from './fixtures';

describe('Money', () => {
  test('preserves precision beyond safe integer range and fixed-scale JSON', () => {
    const large = money('9007199254740993123456789.99');
    const sum = large.add(money('0.01'));
    expect(sum.toString()).toBe('9007199254740993123456790.00');
    expect(sum.subtract(money('0.01')).equals(large)).toBe(true);
    expect(JSON.parse(JSON.stringify(sum))).toEqual({ amount: '9007199254740993123456790.00', currency: 'BRL' });
    expect(Money.from(sum.toJSON()).equals(sum)).toBe(true);
  });

  test('exact arithmetic, signed internal results and predicates', () => {
    const a = money('0.10');
    const b = money('0.20');
    expect(a.add(b).toString()).toBe('0.30');
    const negative = a.subtract(b);
    expect(negative.toString()).toBe('-0.10');
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.negate().equals(a)).toBe(true);
    expect(a.isPositive()).toBe(true);
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a.subtract(a).isZero()).toBe(true);
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
    expect(Money.rehydrate(negative.toJSON()).equals(negative)).toBe(true);
    expect(Money.rehydrate({ amount: '-0.00', currency: 'BRL' }).toString()).toBe('0.00');
  });

  test.each(['', ' ', 'NaN', 'Infinity', '-Infinity', 'nan', '1e2', '1E+2', '1.234', '1', '1.2',
    '-1.00', '-0.00', '+1.00', ' 1.00', '1.00 ', '01.00', '.50', '1,00', '0x10', '1.00\n'])('rejects external %j', (amount) => {
    expectCode(() => money(amount), FailureCode.InvalidAmount);
  });

  test('rejects monetary numbers at runtime and does not round', () => {
    expectCode(() => money(0.1 as unknown as string), FailureCode.InvalidAmount);
    expectCode(() => money('0.005'), FailureCode.InvalidAmount);
    expectCode(() => Money.rehydrate({ amount: '-1.234', currency: 'BRL' }), FailureCode.InvalidAmount);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'B1L', 'BRL '])('rejects malformed currency %j', (currency) => {
    expectCode(() => Money.zero(currency), FailureCode.InvalidCurrency);
  });

  test('all binary operations reject currency mismatch, including equals and zero', () => {
    const brl = Money.zero('BRL');
    const usd = Money.zero('USD');
    for (const operation of [() => brl.add(usd), () => brl.subtract(usd), () => brl.equals(usd), () => brl.isLessThan(usd)]) {
      expectCode(operation, FailureCode.CurrencyMismatch);
    }
  });

  test('immutable operands and defensive serialization', () => {
    const a = money('1.00');
    const result = a.add(money('2.00'));
    expect(a.toString()).toBe('1.00');
    expect(result).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    const json = a.toJSON() as { amount: string; currency: string };
    json.amount = '99.00';
    expect(a.toString()).toBe('1.00');
    expect(() => Object.assign(a, { currency: 'USD' })).toThrow();
  });
});
