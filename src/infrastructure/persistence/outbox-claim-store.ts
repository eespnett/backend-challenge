import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxClaim, OutboxClaimStore } from '../../application/outbox-ports';

export class MikroOrmOutboxClaimStore implements OutboxClaimStore {
  constructor(private readonly orm: MikroORM) {}
  async claim(owner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]> {
    if (!owner.trim() || !Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(leaseMs) || leaseMs<100 || leaseMs>300000) {
      throw new Error('Invalid outbox claim options');
    }
    return this.orm.em.fork({clear:true,useContext:false}).transactional(async(em)=>{
      const rows=await em.execute<Array<{id:string;payload:Record<string,unknown>;lease_token:string;attempts:number}>>(`with due as (
        select id from wagering.outbox_events where published_at is null and next_attempt_at<=statement_timestamp()
          and (lease_until is null or lease_until<=statement_timestamp())
        order by created_at,id for update skip locked limit ?)
        update wagering.outbox_events o set attempts=o.attempts+1,last_attempt_at=statement_timestamp(),
          lease_token=gen_random_uuid(),lease_owner=?,lease_until=statement_timestamp()+?*interval '1 millisecond'
        from due where o.id=due.id returning o.id,o.payload,o.lease_token,o.attempts`,[limit,owner,leaseMs]);
      return rows.map((row)=>({eventId:row.id,payload:row.payload,leaseToken:row.lease_token,attempts:row.attempts}));
    });
  }
  async renew(claim: OutboxClaim, leaseMs: number): Promise<boolean> {
    return this.update(claim,"lease_until=clock_timestamp()+?*interval '1 millisecond'",[leaseMs]);
  }
  async published(claim: OutboxClaim): Promise<boolean> {
    return this.update(claim,'published_at=clock_timestamp(),lease_token=null,lease_owner=null,lease_until=null,last_error=null',[]);
  }
  async retry(claim: OutboxClaim, errorCode: string, delayMs: number): Promise<boolean> {
    return this.update(claim,`next_attempt_at=clock_timestamp()+?*interval '1 millisecond',last_error=?,
      lease_token=null,lease_owner=null,lease_until=null`,[delayMs,errorCode]);
  }
  private async update(claim: OutboxClaim, assignment: string, params: unknown[]): Promise<boolean> {
    return this.orm.em.fork({clear:true,useContext:false}).transactional(async(em)=>{
      // Never evaluate lease validity before a potentially long row-lock wait.
      // SKIP LOCKED acquires immediately; the subsequent UPDATE checks server time under that lock.
      const owned=await em.execute('select id from wagering.outbox_events where id=? for update skip locked',[claim.eventId]);
      if(owned.length===0)return false;
      const rows=await em.execute(`update wagering.outbox_events set ${assignment}
        where id=? and published_at is null and lease_token=? and lease_until>clock_timestamp() returning id`,[...params,claim.eventId,claim.leaseToken]);
      return rows.length===1;
    });
  }
}
