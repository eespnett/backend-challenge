import { EntityManager } from '@mikro-orm/postgresql';
import { InboxRecord, InboxRepository, WAGER_CONSUMER } from '../../application/inbox-ports';
import { StoredProcessingResult } from '../../application/processing-result';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}
  async reserve(messageId: string, hash: string): Promise<InboxRecord> {
    await this.em.execute(`insert into wagering.consumer_inbox(consumer_name,message_id,payload_hash)
      values(?,?,?) on conflict(consumer_name,message_id) do nothing`, [WAGER_CONSUMER,messageId,hash]);
    const rows = await this.em.execute<Array<{ payload_hash: string; status: InboxRecord['status']; result: InboxRecord['result'] }>>(
      `select payload_hash,status,result from wagering.consumer_inbox where consumer_name=? and message_id=? for update`, [WAGER_CONSUMER,messageId]);
    const row = rows[0]!;
    return { payloadHash: row.payload_hash, status: row.status, result: row.result };
  }
  async finish(messageId: string, hash: string, result: StoredProcessingResult): Promise<void> {
    await this.complete(messageId, hash, 'PROCESSED', result, null);
  }
  async reject(messageId: string, hash: string, errorCode: string): Promise<void> {
    await this.complete(messageId, hash, 'REJECTED', { errorCode }, errorCode);
  }
  private async complete(messageId: string, hash: string, status: string, result: unknown, code: string | null) {
    const rows = await this.em.execute(`update wagering.consumer_inbox set status=?,processed_at=clock_timestamp(),result=?::jsonb,error_code=?
      where consumer_name=? and message_id=? and payload_hash=? and status='RECEIVED' returning message_id`,
      [status,JSON.stringify(result),code,WAGER_CONSUMER,messageId,hash]);
    if (rows.length !== 1) throw new Error('Inbox completion ownership lost');
  }
  async deadLetter(messageId: string, hash: string, body: string, transportId: string, errorCode: string) {
    await this.em.execute(`insert into wagering.consumer_dead_letters(consumer_name,message_id,payload_hash,original_body,transport_message_id,error_code)
      values(?,?,?,?,?,?) on conflict do nothing`,[WAGER_CONSUMER,messageId,hash,body,transportId,errorCode]);
    const rows = await this.em.execute<Array<{ sent_at: Date | null }>>(`select sent_at from wagering.consumer_dead_letters
      where consumer_name=? and message_id=? and payload_hash=?`,[WAGER_CONSUMER,messageId,hash]);
    return { sent: rows[0]!.sent_at !== null };
  }
  async markDeadLetterSent(messageId: string, hash: string): Promise<void> {
    await this.em.execute(`update wagering.consumer_dead_letters set sent_at=coalesce(sent_at,clock_timestamp())
      where consumer_name=? and message_id=? and payload_hash=?`,[WAGER_CONSUMER,messageId,hash]);
  }
}
