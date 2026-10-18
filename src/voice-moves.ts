import { setTimeout as delay } from 'node:timers/promises';
import { UserError } from './types.js';
import { moveCounts, type MoveInput, type MoveJob, type MoveMember, type VoiceMoveRepository } from './voice-move-types.js';

export class MoveInterrupted extends Error {}
export class RetryMove extends Error {
  constructor(readonly waitMs: number) { super('Discord rate limit'); }
}
export interface MemberOutcome {
  status: 'moved' | 'skipped' | 'failed' | 'unknown';
  reason: string | null;
}
export interface MoveGateway {
  ready(): boolean;
  validate(input: MoveInput): Promise<void>;
  move(member: MoveMember, input: MoveInput, signal: AbortSignal): Promise<MemberOutcome>;
}

/** Runs independently of voice receive/mixing. Persistence always precedes side effects. */
export class VoiceMoveService {
  private stopping = false;
  private active = new Map<string, Promise<void>>();
  private abort = new AbortController();
  constructor(readonly repository: VoiceMoveRepository, private onError: (error: unknown) => void) {}

  run(input: MoveInput, gateway: MoveGateway, notify: (job: MoveJob) => Promise<void>, confirmBy = (input.snapshotAt ?? 0) + 60000): Promise<void> {
    if (this.stopping) return Promise.reject(new UserError('Dịch vụ đang dừng.'));
    if (this.active.has(input.guildId)) return Promise.reject(new UserError('Guild đang có một tác vụ Mass Voice Move thực thi.'));
    // Reserve synchronously before any permission, DB or Discord await.
    const task = Promise.resolve().then(() => this.execute(input, gateway, notify, confirmBy));
    this.active.set(input.guildId, task);
    void task.finally(() => this.active.delete(input.guildId)).catch(() => {});
    return task;
  }

  private async execute(input: MoveInput, gateway: MoveGateway, notify: (job: MoveJob) => Promise<void>, confirmBy: number): Promise<void> {
    await gateway.validate(input);
    if (this.stopping || !gateway.ready()) throw new UserError('Gateway chưa sẵn sàng hoặc dịch vụ đang dừng. Hãy mở phiên mới.');
    if (input.snapshotAt === null || Date.now() >= confirmBy) throw new UserError('Snapshot hoặc phiên đã hết hạn. Hãy mở phiên mới và xem trước lại.');
    await this.repository.create(input);
    let lastProgress = 0;
    const progress = async (force = false) => {
      if (!force && Date.now() - lastProgress < 5000) return;
      lastProgress = Date.now();
      const job = await this.repository.get(input.id, input.guildId);
      if (job) await notify(job).catch(this.onError);
    };
    try {
      if (Date.now() >= confirmBy) throw new MoveInterrupted('confirmation_expired_before_start');
      await progress(true);
      for (const member of input.members) {
        if (this.stopping || !gateway.ready()) throw new MoveInterrupted('gateway_or_shutdown');
        await this.repository.processing(input.id, member.userId);
        let outcome: MemberOutcome;
        for (;;) {
          if (this.stopping || !gateway.ready()) throw new MoveInterrupted('gateway_or_shutdown');
          try { outcome = await gateway.move(member, input, this.abort.signal); break; }
          catch (error) {
            if (!(error instanceof RetryMove)) throw error;
            // The refused request had no side effect. Re-enter move() after waiting so
            // voice position, capacity and permissions are checked again before retry.
            const retryAt = Date.now() + Math.max(1, error.waitMs);
            while (Date.now() < retryAt) {
              await delay(Math.min(5000, retryAt - Date.now()), undefined, { signal: this.abort.signal });
              if (!gateway.ready()) throw new MoveInterrupted('gateway_unavailable');
              await progress();
            }
          }
        }
        await this.repository.outcome(input.id, member.userId, outcome.status, outcome.reason);
        await progress();
      }
      await this.repository.finish(input.id);
    } catch (error) {
      this.onError(error);
      await this.repository.finish(input.id, error instanceof MoveInterrupted ? error.message : 'execution_interrupted').catch(this.onError);
    }
    await progress(true);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await Promise.allSettled(this.active.values());
  }
}

export function formatMoveJob(job: MoveJob): string {
  const counts = moveCounts(job);
  const reasons = new Map<string, number>();
  for (const member of job.members) if (member.reason) reasons.set(member.reason, (reasons.get(member.reason) ?? 0) + 1);
  return [`/voice move-all — ${job.status}`, `Job: ${job.id}`, `Người gọi: ${job.actorId}; guild: ${job.guildId}`,
    `Bắt đầu: ${job.createdAt}${job.finishedAt ? `; kết thúc: ${job.finishedAt}` : ''}`,
    `Đích: ${job.destinationId ? `<#${job.destinationId}>` : 'chưa chọn'}; ${job.sources.length} nguồn`,
    `Snapshot: ${counts.total}; đã chuyển: ${counts.moved}; bỏ qua: ${counts.skipped}; thất bại/chưa rõ: ${counts.failed}; đang chờ: ${counts.pending}; bot bỏ qua: ${job.botsSkipped}`,
    ...[...reasons].slice(0, 10).map(([reason, count]) => `${reason}: ${count}`),
    ...(reasons.size > 10 ? ['Các nguyên nhân khác nằm trong chi tiết tác vụ.'] : []),
    ...(job.reason ? [`Lý do tác vụ: ${job.reason}`] : []),
    'Chi tiết: /voice move-status job:' + job.id].join('\n');
}
