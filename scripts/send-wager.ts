import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { AppConfig } from '../src/config/app-config';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmTransactionManager } from '../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { SqsService } from '../src/infrastructure/sqs/sqs.service';
import { validateWagerEnvelope } from '../src/application/wager-envelope';
import { CliInputError, DEMO_PLAYER, runCli } from './cli';

const optionNames = ['file', 'wallet-id', 'player-id', 'provider-id', 'external-transaction-id', 'idempotency-key',
  'message-id', 'round-id', 'game-id', 'kind', 'amount', 'currency', 'reference-external-transaction-id'] as const;
export async function sendWager(args = process.argv.slice(2)): Promise<void> {
  let values: Partial<Record<typeof optionNames[number], string>>;
  try { values = parseArgs({ args, options: Object.fromEntries(optionNames.map((key) => [key, { type: 'string' as const }])), strict: true }).values; }
  catch { throw new CliInputError('Usage: bun run send-wager [--file envelope.json | --wallet-id UUID --player-id ID --kind BET --amount 25.00 ...]'); }
  if (Object.values(values).some((value) => value === '')) throw new CliInputError('Options must have non-empty values');
  const config = new AppConfig();
  let raw: string;
  if (values.file) {
    if (Object.keys(values).length !== 1) throw new CliInputError('--file cannot be combined with envelope overrides');
    const file = Bun.file(values.file);
    if (file.size > 1048576) throw new CliInputError('Envelope file exceeds 1 MiB');
    raw = await file.text();
  } else {
    let walletId = values['wallet-id']; let playerId = values['player-id'];
    let currency = values.currency;
    if (Boolean(walletId) !== Boolean(playerId)) throw new CliInputError('Provide both --wallet-id and --player-id, or run seed and omit both');
    if (!walletId) {
      const orm = await MikroORM.init(createOrmConfig(config));
      try {
        const wallet = await new MikroOrmTransactionManager(orm).run((uow) => uow.wallets.findByPlayerAndCurrency(DEMO_PLAYER, currency ?? 'BRL'));
        if (!wallet) throw new CliInputError('Demo wallet not found; run bun run seed first');
        walletId = wallet.id; playerId = wallet.playerId; currency ??= wallet.currency;
      } finally { await orm.close(true); }
    }
    raw = JSON.stringify({ messageId: values['message-id'] ?? crypto.randomUUID(), type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(), data: { providerId: values['provider-id'] ?? 'demo-provider',
        externalTransactionId: values['external-transaction-id'] ?? crypto.randomUUID(), idempotencyKey: values['idempotency-key'] ?? crypto.randomUUID(),
        playerId, walletId, roundId: values['round-id'] ?? 'demo-round', gameId: values['game-id'] ?? 'demo-game',
        kind: values.kind ?? 'BET', money: { amount: values.amount ?? '25.00', currency: currency ?? 'BRL' },
        ...(values['reference-external-transaction-id'] === undefined ? {} : { referenceExternalTransactionId: values['reference-external-transaction-id'] }) } });
  }
  let envelope: ReturnType<typeof validateWagerEnvelope>;
  try { envelope = validateWagerEnvelope(raw); } catch { throw new CliInputError('Invalid wager envelope; money must be decimal strings with two places'); }
  const sqs = new SqsService(config);
  try {
    const QueueUrl = await sqs.queueUrl(config.messaging.queueName);
    const sent = await sqs.client.send(new SendMessageCommand({ QueueUrl, MessageBody: raw,
      MessageGroupId: envelope.body.walletId as string, MessageDeduplicationId: envelope.messageId }), { abortSignal: AbortSignal.timeout(10000) });
    if (!sent.MessageId) throw new Error('SQS send was not confirmed');
    console.log(JSON.stringify({ event: 'wager_sent', messageId: envelope.messageId, walletId: envelope.body.walletId,
      providerId: envelope.body.providerId, externalTransactionId: envelope.body.externalTransactionId }));
  } finally { sqs.onApplicationShutdown(); }
}

void runCli('send_wager_failed', () => sendWager());
