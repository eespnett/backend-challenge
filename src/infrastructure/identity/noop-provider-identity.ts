import { Module } from '@nestjs/common';
import { PROVIDER_IDENTITY, ProviderIdentityPort } from '../../application/provider-identity-port';

/** Explicit development adapter: no token validation or access control. */
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async assertProviderAccess(_providerId: string, _authorization?: string): Promise<void> {}
}
@Module({ providers: [{ provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentityAdapter }], exports: [PROVIDER_IDENTITY] })
export class ProviderIdentityModule {}
