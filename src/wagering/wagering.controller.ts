import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, Param, Post, Res, ServiceUnavailableException } from '@nestjs/common';
import { QueryService } from '../queries/query.service';
import { PROVIDER_IDENTITY } from '../application/provider-identity-port';
import type { ProviderIdentityPort } from '../application/provider-identity-port';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { InfrastructureUnavailableError, InvalidWagerRequestError, ProcessingConflictError } from '../application/processing-errors';
import { DomainError } from '../domain/domain-error';

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(ProcessWagerTransactionUseCase) private readonly process: ProcessWagerTransactionUseCase,
    @Inject(QueryService) private readonly queries: QueryService,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string) { return this.queries.transaction(transactionId); }

  @Post()
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
    @Headers('authorization') authorization?: string) {
    try {
      if (body && typeof body === 'object' && typeof (body as { providerId?: unknown }).providerId === 'string') {
        await this.identity.assertProviderAccess((body as { providerId: string }).providerId, authorization);
      }
      const result = await this.process.execute(body, key, { correlationId });
      response.status(result.httpStatus);
      return result.body;
    } catch (error) {
      if (error instanceof InvalidWagerRequestError || error instanceof DomainError) {
        throw new BadRequestException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof ProcessingConflictError) {
        throw new ConflictException({ failureCode: error.code, message: error.message });
      }
      if (error instanceof InfrastructureUnavailableError) {
        throw new ServiceUnavailableException({ failureCode: error.code, message: error.message });
      }
      throw error;
    }
  }
}
