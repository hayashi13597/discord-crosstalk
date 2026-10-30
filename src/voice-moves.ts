import { UserError } from './types.js';
import { moveCounts, type MoveInput, type MoveJob, type MoveMember, type VoiceMoveRepository, type MoveVerification } from './voice-move-types.js';

export class MoveInterrupted extends Error {}
export class MoveRetry extends Error {
  constructor(readonly retryAfterMs: number) { super('rate_limited'); }
}
export interface MoveScan extends MoveVerification {
  resolved: Array<{ userId: string; status: 'moved' | 'skipped'; reason: string | null }>;
}
const MAX_ROUNDS = 5;
const MAX_ATTEMPTS = 3;
const JOB_MS = 120000;
const fatalReasons = new Set(['destination_full', 'missing_permissions', 'channel_unavailable']);
const retryReasons = new Set(['rate_limited', 'discord_unavailable', 'voice_state_unverified', 'outcome_unknown']);
// Ephemeral progress replies dismissed by the caller (10008) or expired interaction tokens (10062, 50027)
// must not abort moving remaining members; durable results remain inspectable via /voice move-status.
function isDismissedProgressError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && [10008, 10062, 50027].includes(Number(error.code)));
}

export interface MemberOutcome {
  status: 'moved' | 'skipped' | 'failed' | 'unknown';
  reason: string | null;
  retryAfterMs?: number;
}
export interface MoveGateway {
  ready(): boolean;
  validate(input: MoveInput): Promise<void>;
  scan(input: MoveInput, signal: AbortSignal): Promise<MoveScan>;
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
    if (this.stopping || !gateway.ready()) throw new UserError('Gateway chưa sẵn sàng hoặc dịch vụ đang dừng. Hãy chạy lại /voice move-all.');
    if (input.snapshotAt === null || Date.now() >= confirmBy) throw new UserError('Snapshot đã hết hạn. Hãy chạy lại /voice move-all.');
    await this.repository.create(input);
    let lastProgress = 0;
    let progressDismissed = false;
    const progress = async (force = false) => {
      if (progressDismissed) return;
      if (!force && Date.now() - lastProgress < 5000) return;
      lastProgress = Date.now();
      const job = await this.repository.get(input.id, input.guildId);
      if (!job) throw new Error('Voice move audit not found');
      try { await notify(job); }
      catch (error) {
        this.onError(error);
        if (isDismissedProgressError(error)) {
          progressDismissed = true;
          return;
        }
        throw new MoveInterrupted('progress_delivery_failed');
      }
    };
    const deadline = Date.now() + JOB_MS;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(JOB_MS)]);
    const attempts = new Map<string, number>();
    const check = () => {
      if (this.stopping || !gateway.ready() || this.abort.signal.aborted) throw new MoveInterrupted('gateway_or_shutdown');
      if (Date.now() >= deadline || signal.aborted) throw new MoveInterrupted('time_limit');
    };
    const wait = async (ms: number) => {
      check();
      if (!Number.isFinite(ms) || ms >= deadline - Date.now()) throw new MoveInterrupted('time_limit');
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, Math.max(1, ms));
          function done() { signal.removeEventListener('abort', aborted); resolve(); }
          function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); }
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      catch { check(); throw new MoveInterrupted('gateway_or_shutdown'); }
      check();
    };
    const scan = async (): Promise<MoveScan> => {
      for (let retry = 0; ; retry++) {
        check();
        try { return await gateway.scan(input, signal); }
        catch (error) {
          check();
          if (error instanceof MoveInterrupted || error instanceof UserError) throw error;
          if (retry >= 2) throw error instanceof MoveRetry ? error : new MoveInterrupted('verification_failed');
          await wait(error instanceof MoveRetry ? error.retryAfterMs : 1000 * (retry + 1));
        }
      }
    };
    const recordScan = async (result: MoveScan) => {
      const known = new Set(input.members.map(member => member.userId));
      const added = result.remaining.filter(member => !known.has(member.userId));
      if (added.length) {
        await this.repository.enqueue(input.id, added);
        input.members.push(...added);
      }
      const job = await this.repository.get(input.id, input.guildId);
      if (!job) throw new Error('Voice move audit not found');
      for (const member of result.resolved) {
        const previous = job.members.find(value => value.userId === member.userId);
        if (!previous) continue;
        if (member.reason === 'already_at_destination' && ['moved', 'unknown'].includes(previous.status)) {
          await this.repository.outcome(input.id, member.userId, 'moved', 'verified_at_destination');
        } else if (previous.status !== 'moved') {
          await this.repository.outcome(input.id, member.userId, member.status, member.reason);
        }
      }
      await this.repository.verify(input.id, { checkedAt: result.checkedAt, remaining: result.remaining, unverified: result.unverified });
    };
    try {
      if (Date.now() >= confirmBy) throw new MoveInterrupted('confirmation_expired_before_start');
      await progress(true);
      let queue = input.members;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        check();
        for (const member of queue) {
          const used = attempts.get(member.userId) ?? 0;
          if (used >= MAX_ATTEMPTS) continue;
          let outcome: MemberOutcome;
          do {
            check();
            const currentAttempts = attempts.get(member.userId) ?? 0;
            // Initial Round 0 members are already persisted as 'pending' by repository.create().
            if (round > 0 || currentAttempts > 0) await this.repository.enqueue(input.id, [member]);
            await this.repository.processing(input.id, member.userId);
            check();
            attempts.set(member.userId, currentAttempts + 1);
            outcome = await gateway.move(member, input, signal);
            await this.repository.outcome(input.id, member.userId, outcome.status, outcome.reason);
            if (fatalReasons.has(outcome.reason ?? '')) throw new MoveInterrupted(outcome.reason!);
            await progress();
            if (outcome.reason === 'rate_limited') await wait(outcome.retryAfterMs ?? 1000);
            if (!retryReasons.has(outcome.reason ?? '') || attempts.get(member.userId)! >= MAX_ATTEMPTS) break;
            // Every retry enters gateway.move again, which reads the current voice position before PATCH.
            if (outcome.reason !== 'rate_limited') await wait(1000 * attempts.get(member.userId)!);
          } while (true);
        }
        let result = await scan();
        await recordScan(result);
        check();
        if (!result.remaining.length && !result.unverified.length) {
          await wait(1000);
          result = await scan();
          await recordScan(result);
          check();
          if (!result.remaining.length && !result.unverified.length) {
            break;
          }
        }
        if (round === MAX_ROUNDS - 1) throw new MoveInterrupted(result.unverified.length ? 'verification_failed' : 'round_limit');
        const job = await this.repository.get(input.id, input.guildId);
        if (!job) throw new Error('Voice move audit not found');
        queue = result.remaining.filter(member => {
          const previous = job.members.find(value => value.userId === member.userId);
          return (attempts.get(member.userId) ?? 0) < MAX_ATTEMPTS &&
            (previous?.status !== 'failed' || retryReasons.has(previous.reason ?? ''));
        });
        if (!queue.length && !result.unverified.length) throw new MoveInterrupted('members_remaining');
        await wait(1000);
      }
      await this.repository.finish(input.id);
    } catch (error) {
      this.onError(error);
      const reason = this.stopping || this.abort.signal.aborted ? 'gateway_or_shutdown' :
        signal.aborted || Date.now() >= deadline ? 'time_limit' :
        error instanceof MoveInterrupted ? error.message : error instanceof MoveRetry ? 'rate_limited' : 'execution_interrupted';
      await this.repository.finish(input.id, reason);
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
    `Đã theo dõi: ${counts.total}; đã chuyển: ${counts.moved}; bỏ qua: ${counts.skipped}; thất bại/chưa rõ: ${counts.failed}; đang chờ: ${counts.pending}; bot bỏ qua: ${job.botsSkipped}`,
    job.verification ? `Kiểm tra nguồn: ${new Date(job.verification.checkedAt).toISOString()}; còn ${job.verification.remaining.length} người; chưa xác minh ${job.verification.unverified.length}.` : 'Chưa xác minh được nguồn lúc kết thúc.',
    ...(job.verification?.remaining.map(member => `Còn ở nguồn: ${member.userId} tại <#${member.sourceId}>`) ?? []).slice(0, 10),
    ...(job.verification?.unverified.map(id => `Chưa xác minh: ${id}`) ?? []).slice(0, 10),
    ...[...reasons].slice(0, 10).map(([reason, count]) => `${reason}: ${count}`),
    ...(reasons.size > 10 ? ['Các nguyên nhân khác nằm trong chi tiết tác vụ.'] : []),
    ...(job.reason ? [`Lý do tác vụ: ${job.reason}`] : []),
    'Chi tiết: /voice move-status job:' + job.id].join('\n');
}
