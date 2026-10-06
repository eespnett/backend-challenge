import { MikroORM } from '@mikro-orm/postgresql';
import { EVENT_RECEIPT_CONSUMER, validateIntegrationEvent } from '../../application/integration-event-envelope';

export class EventIdentityConflict extends Error {}
/** The receipt itself is the minimal durable effect; no financial/domain mutation. */
export class MikroOrmEventReceiptStore {
  constructor(private readonly orm: MikroORM) {}
  async consume(event: ReturnType<typeof validateIntegrationEvent>,signal:AbortSignal):Promise<'CONSUMED'|'REPLAY'> {
    signal.throwIfAborted();
    return this.orm.em.fork({clear:true,useContext:false}).transactional(async(em)=>{
      const inserted=await em.execute(`insert into wagering.integration_event_receipts(consumer_name,event_id,payload_hash,event_type,payload)
        values(?,?,?,?,?::jsonb) on conflict(consumer_name,event_id) do nothing returning event_id`,
        [EVENT_RECEIPT_CONSUMER,event.eventId,event.hash,event.eventType,JSON.stringify(event.payload)]);
      if(inserted.length===0){
        const rows=await em.execute<Array<{payload_hash:string}>>('select payload_hash from wagering.integration_event_receipts where consumer_name=? and event_id=?',
          [EVENT_RECEIPT_CONSUMER,event.eventId]);
        if(rows[0]?.payload_hash!==event.hash)throw new EventIdentityConflict('Event identity payload conflict');
      }
      signal.throwIfAborted();
      return inserted.length===1?'CONSUMED':'REPLAY';
    });
  }
}
