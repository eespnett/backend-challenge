import { PendingReferenceClaimStore } from './pending-reference-ports';
import { PENDING_REFERENCE_BATCH_SIZE, PENDING_REFERENCE_LEASE_MS } from './pending-reference-schedule';
import { ReprocessPendingReferenceUseCase } from './reprocess-pending-reference';

export class RunPendingReferenceBatch {
  constructor(private readonly claims: PendingReferenceClaimStore, private readonly reprocess: ReprocessPendingReferenceUseCase,
    private readonly workerId: string) {}

  async execute() {
    const claims = await this.claims.claim(this.workerId, PENDING_REFERENCE_BATCH_SIZE, PENDING_REFERENCE_LEASE_MS);
    // Failed processing leaves the committed lease for durable recovery; no partial financial writes.
    return Promise.allSettled(claims.map((claim) => this.reprocess.execute(claim)));
  }
}
