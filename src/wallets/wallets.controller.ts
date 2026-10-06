import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryService } from '../queries/query.service';
import { OpenWallet, OpenWalletInput } from '../application/open-wallet';
import { WalletAlreadyExistsError } from '../application/financial-unit-of-work';
import { DomainError } from '../domain/domain-error';
import { InfrastructureUnavailableError } from '../application/processing-errors';

function parseInput(body: unknown): OpenWalletInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ failureCode: 'INVALID_REQUEST', message: 'Expected a wallet request object' });
  }
  const input = body as Record<string, unknown>;
  const balance = input.initialBalance;
  if (typeof input.playerId !== 'string' || input.playerId.trim() === '' ||
      balance === null || typeof balance !== 'object' || Array.isArray(balance)) {
    throw new BadRequestException({ failureCode: 'INVALID_REQUEST', message: 'playerId and initialBalance are required' });
  }
  const props = balance as Record<string, unknown>;
  if (typeof props.amount !== 'string' || typeof props.currency !== 'string') {
    throw new BadRequestException({ failureCode: 'INVALID_REQUEST', message: 'Amount and currency must be strings' });
  }
  return { playerId: input.playerId, initialBalance: { amount: props.amount, currency: props.currency } };
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(QueryService) private readonly queries: QueryService) {}

  @Get(':walletId')
  get(@Param('walletId') walletId: string) { return this.queries.wallet(walletId); }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    return this.queries.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Headers('x-correlation-id') correlationId?: string) {
    return this.queries.reconcile(walletId, correlationId ?? randomUUID());
  }

  @Post()
  async open(@Body() body: unknown) {
    try {
      const wallet = await this.openWallet.execute(parseInput(body));
      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof DomainError) {
        throw new BadRequestException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof InfrastructureUnavailableError) {
        throw new ServiceUnavailableException({ failureCode: error.code, message: error.message });
      }
      throw error;
    }
  }
}
