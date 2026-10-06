import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { PROVIDER_IDENTITY } from '../application/provider-identity-port';
import type { ProviderIdentityPort } from '../application/provider-identity-port';
import { QueryService } from '../queries/query.service';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(@Inject(QueryService) private readonly queries: QueryService,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}
  @Get(':externalTransactionId')
  async get(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string,
    @Headers('authorization') authorization?: string) {
    await this.identity.assertProviderAccess(providerId, authorization);
    return this.queries.providerTransaction(providerId, externalId);
  }
}
