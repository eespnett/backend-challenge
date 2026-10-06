/** Future OIDC adapter validates the token and its provider scope before returning. */
export interface ProviderIdentityPort {
  assertProviderAccess(providerId: string, authorization?: string): Promise<void>;
}
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
