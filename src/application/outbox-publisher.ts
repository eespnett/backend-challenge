import { EventTransport, OutboxClaim, OutboxClaimStore, outboxBackoffMs } from './outbox-ports';

export type PublishOutcome = 'PUBLISHED' | 'RETRY' | 'STALE' | 'ABANDONED';
export class OutboxPublisher {
  constructor(private readonly store: OutboxClaimStore, private readonly transport: EventTransport,
    private readonly owner: string, private readonly leaseMs = 30000) {}

  async run(signal: AbortSignal = new AbortController().signal): Promise<readonly PublishOutcome[]> {
    if (signal.aborted) return [];
    // claim() commits before transport is invoked. No financial transaction is involved.
    const claims = await this.store.claim(this.owner,5,this.leaseMs);
    const results=await Promise.allSettled(claims.map((claim) => this.publish(claim,signal)));
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failures.length)throw new AggregateError(failures.map((result)=>result.reason),'Outbox batch unavailable');
    return results.map((result)=>(result as PromiseFulfilledResult<PublishOutcome>).value);
  }
  private async publish(claim: OutboxClaim, parent: AbortSignal): Promise<PublishOutcome> {
    if (parent.aborted) return 'ABANDONED';
    const delivery = new AbortController();
    const abort = () => delivery.abort();
    parent.addEventListener('abort',abort,{once:true});
    let renewal: Promise<void> | undefined;
    let stale = false;
    const timer = setInterval(() => {
      if (renewal || delivery.signal.aborted) return;
      renewal = this.store.renew(claim,this.leaseMs).then((owned) => {
        if (!owned) { stale=true; delivery.abort(); }
      }).catch(() => { stale=true; delivery.abort(); }).finally(() => { renewal=undefined; });
    },Math.max(25,Math.floor(this.leaseMs/3)));
    timer.unref();
    let sent = false;
    try {
      if (parent.aborted) { delivery.abort(); return 'ABANDONED'; }
      await this.transport.send(claim,delivery.signal);
      sent=true;
      clearInterval(timer);
      await renewal;
      if (parent.aborted) return 'ABANDONED';
      if (stale || delivery.signal.aborted) return 'STALE';
      return await this.store.published(claim) ? 'PUBLISHED' : 'STALE';
    } catch {
      clearInterval(timer);
      await renewal;
      if (parent.aborted) return 'ABANDONED';
      if (stale || delivery.signal.aborted) return 'STALE';
      // Even persistent failures stay pending; retry never deletes or invents an event.
      return await this.store.retry(claim,sent?'PUBLICATION_CONFIRMATION_FAILED':'SQS_SEND_FAILED',outboxBackoffMs(claim.attempts)) ? 'RETRY' : 'STALE';
    } finally {
      clearInterval(timer); parent.removeEventListener('abort',abort);
      await renewal;
    }
  }
}
