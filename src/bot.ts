import { Client, Events, GatewayIntentBits, ChannelType, Options, PermissionFlagsBits, RateLimitError, RESTEvents, Status, type Interaction } from 'discord.js';
import { entersState, EndBehaviorType, joinVoiceChannel, VoiceConnectionStatus,
  type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { createCodec, type Codec } from './audio/codec.js';
import { AudioRouter } from './audio/router.js';
import { VoiceOutput } from './audio/output.js';
import { registerCommands } from './commands.js';
import { safeError } from './logger.js';
import { gatewayRestOptions } from './gateway-rest.js';
import type { LeaderPresence } from './types.js';

export interface BotStatus<T = number> extends LeaderPresence {
  team: T;
  gateway: boolean;
  voice: string;
  channelId: string | null;
  leaderPresent: boolean;
  receiving: boolean;
  lastError: string | null;
}
interface Capture { userId: string; epoch: number; stream: AudioReceiveStream; codec: Codec }

export function retryDelay(attempt: number, random = Math.random): number {
  return Math.round(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + 0.2 * random()));
}

async function deadline<T>(promise: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(timeoutError()), ms);
    })]);
  } finally { clearTimeout(timeout); }
}

function gatewayCloseError(code: number): Error {
  const message = code === 4004 ? 'Discord authentication failed; check this worker\'s BOT_TOKEN'
    : code === 4014 ? 'Discord rejected privileged intents; enable Server Members Intent for this bot in the Developer Portal'
    : code === 4013 ? 'Discord rejected invalid gateway intents'
    : `Discord gateway disconnected with close code ${code}`;
  return Object.assign(new Error(message), { code: `DISCORD_GATEWAY_CLOSED_${code}` });
}

export interface WorkerOptions {
  workerId: number;
  token: string;
  channelId: string | null;
  active: boolean;
  onIdentity: (userId: string) => Promise<void>;
}

const workerCacheFactory = Options.cacheWithLimits({
  ApplicationCommandManager: 0,
  ApplicationEmojiManager: 0,
  AutoModerationRuleManager: 0,
  BaseGuildEmojiManager: 0,
  DMMessageManager: 0,
  EntitlementManager: 0,
  GuildBanManager: 0,
  GuildEmojiManager: 0,
  GuildForumThreadManager: 0,
  GuildInviteManager: 0,
  GuildMessageManager: 0,
  GuildScheduledEventManager: 0,
  GuildStickerManager: 0,
  GuildTextThreadManager: 0,
  MessageManager: 0,
  PresenceManager: 0,
  ReactionManager: 0,
  ReactionUserManager: 0,
  StageInstanceManager: 0,
  ThreadManager: 0,
  ThreadMemberManager: 0,
});

export class TeamBot<T extends string | number = number> {
  private currentClient: Client;
  get client(): Client { return this.currentClient; }
  readonly output: VoiceOutput;
  private connection?: VoiceConnection;
  private captures = new Map<string, Capture>();
  private membersReady = false;
  private membershipRevision = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private requested = false;
  private attempts = 0;
  private commandsRegistered = false;
  private commandRetryAt = 0;
  private lastError: string | null = null;
  private gatewayStarted = false;
  private gatewayReconnecting = false;
  private gatewayAbort?: AbortController;
  private gatewayFailure?: Error;
  private gatewayRetryAt = 0;

  private revision = 0;
  private identified = false;
  private get workerId(): number { return this.options.workerId; }
  private get token(): string { return this.options.token; }
  private get channelId(): string | null { return this.options.channelId; }
  private get enabled(): boolean { return this.options.active && this.channelId !== null; }

  constructor(public team: T, private config: Config, private router: AudioRouter<T>,
    private log: Logger,
    private onInteraction: ((interaction: Interaction) => void) | undefined, private options: WorkerOptions) {
    this.currentClient = this.createClient();
    this.output = new VoiceOutput(error => this.audioFault(error));
    if (this.channelId) router.attach(team, this.output);
  }

  configure(team: T, router: AudioRouter<T>, channelId: string | null, active: boolean): void {
    if (this.stopped) return;
    ++this.revision;
    this.disable();
    this.destroyConnection();
    this.router.detach(this.team);
    this.team = team;
    this.router = router;
    this.membersReady = false;
    ++this.membershipRevision;
    this.options.channelId = channelId;
    this.options.active = active;
    if (channelId) router.attach(team, this.output);
    this.schedule(0);
  }

  private createClient(): Client {
    const active = () => this.currentClient === client && !this.stopped;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
      makeCache: workerCacheFactory,
      rest: gatewayRestOptions(this.log, this.workerId, active),
    });
    const error = (error: Error) => { if (active()) this.recordError(error); };
    const disconnected = () => {
      if (!active()) return;
      this.gatewayReconnecting = true;
      this.membersReady = false;
      ++this.membershipRevision;
      this.disable();
      this.schedule(0);
    };
    const ready = () => {
      if (!active()) return;
      this.gatewayReconnecting = false;
      this.membersReady = false;
      ++this.membershipRevision;
      this.disable();
      this.schedule(0);
    };
    client.on(Events.Debug, message => {
      // discord.js masks only the signature, leaving the token prefix visible.
      if (message.startsWith('Provided token:')) return;
      if (active()) this.log.debug({ worker: this.workerId, detail: message }, 'Discord gateway debug');
    });
    client.rest.on(RESTEvents.RateLimited, data => {
      if (active()) this.log.warn({ worker: this.workerId, global: data.global,
        scope: data.scope, retryAfterMs: data.retryAfter }, 'Discord REST rate limited; waiting before retry');
    });
    client.on(Events.Error, error);
    client.on(Events.ShardError, error);
    client.on(Events.ShardDisconnect, (event, shardId) => {
      if (!active()) return;
      // discord.js emits shardDisconnect only for an unrecoverable close.
      this.gatewayFailure = gatewayCloseError(event.code);
      this.log.warn({ worker: this.workerId, shardId, closeCode: event.code }, 'Discord gateway disconnected');
      disconnected();
    });
    client.on(Events.ShardReconnecting, disconnected);
    client.on(Events.ClientReady, ready);
    client.on(Events.ShardReady, ready);
    client.on(Events.ShardResume, ready);
    client.on(Events.InteractionCreate, interaction => { if (active()) this.onInteraction?.(interaction); });
    client.on(Events.VoiceStateUpdate, (before, after) => {
      if (!active()) return;
      if (after.guild.id !== this.config.guildId) return;
      if (before.channelId === this.channelId || after.channelId === this.channelId || after.id === this.client.user?.id) {
        ++this.membershipRevision;
        if (after.channelId === this.channelId && !after.member) this.membersReady = false;
        this.refresh();
        this.schedule(0);
      }
    });
    client.on(Events.GuildMemberUpdate, (_before, member) => {
      if (!active() || member.guild.id !== this.config.guildId) return;
      if (member.voice.channelId === this.channelId || this.captures.has(member.id)) {
        ++this.membershipRevision;
        this.refresh();
        this.schedule(0);
      }
    });
    client.on(Events.GuildMemberRemove, member => {
      if (!active() || member.guild.id !== this.config.guildId) return;
      ++this.membershipRevision;
      this.stopCapture(member.id);
      this.refresh();
    });
    client.on(Events.GuildMemberAvailable, member => {
      if (!active() || member.guild.id !== this.config.guildId || member.voice.channelId !== this.channelId) return;
      ++this.membershipRevision;
      this.refresh();
      this.schedule(0);
    });
    client.on(Events.GuildRoleDelete, role => {
      if (!active() || role.guild.id !== this.config.guildId || role.id !== this.config.leaderRoleId) return;
      this.membersReady = false;
      ++this.membershipRevision;
      this.disable();
      this.schedule(0);
    });
    return client;
  }

  start(): void { this.schedule(0); }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.running) { this.requested = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.check(); }, Math.max(ms, this.gatewayRetryAt - Date.now()));
  }

  private async check(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.requested = false;
    let delay = 2000;
    const revision = this.revision;
    try {
      await this.maintain();
      this.attempts = 0;
    } catch (error) {
      if (this.stopped || revision !== this.revision) return;
      this.recordError(error);
      this.disable();
      this.destroyConnection();
      delay = retryDelay(this.attempts++);
    } finally {
      this.running = false;
      // Preserve backoff after failures, even if disconnect events requested an immediate check.
      this.schedule(this.attempts ? delay : this.requested ? 0 : delay);
    }
  }

  private gatewayReady(): boolean {
    return !this.gatewayReconnecting && this.client.isReady();
  }

  private async connectGateway(): Promise<void> {
    const client = this.client;
    if (this.gatewayFailure) throw this.gatewayFailure;
    let phase = this.gatewayStarted ? 'resume' : 'login';
    const abort = new AbortController();
    this.gatewayAbort = abort;
    let checkReady!: () => void;
    let disconnected!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      checkReady = () => { if (this.gatewayReady()) resolve(); };
      disconnected = () => { if (this.gatewayFailure) reject(this.gatewayFailure); };
      client.on(Events.ClientReady, checkReady);
      client.on(Events.ShardReady, checkReady);
      client.on(Events.ShardResume, checkReady);
      client.on(Events.ShardDisconnect, disconnected);
      abort.signal.addEventListener('abort', () => reject(new Error('Discord gateway wait cancelled')), { once: true });
    });
    try {
      this.log.info({ worker: this.workerId, phase }, 'Connecting to Discord gateway');
      // login() can resolve before guilds are available. Register readiness listeners first.
      // During a reconnect, let discord.js resume its existing session instead of logging in again.
      let login = Promise.resolve();
      if (!this.gatewayStarted) {
        this.gatewayStarted = true;
        login = Promise.resolve().then(async () => {
          if (this.stopped) return;
          await client.login(this.token);
          phase = 'client_ready';
          if (this.stopped || this.client !== client) await client.destroy();
        });
      }
      await deadline(Promise.all([ready, login.then(checkReady)]), 30000, () => {
        const status = Status[client.ws.status];
        return Object.assign(new Error(`Discord gateway timed out after 30000ms during ${phase} (status: ${status})`),
          { code: 'DISCORD_GATEWAY_TIMEOUT' });
      });
      this.gatewayRetryAt = 0;
      this.log.info({ worker: this.workerId }, 'Discord gateway ready');
    } finally {
      client.off(Events.ClientReady, checkReady);
      client.off(Events.ShardReady, checkReady);
      client.off(Events.ShardResume, checkReady);
      client.off(Events.ShardDisconnect, disconnected);
      abort.abort();
      if (this.gatewayAbort === abort) this.gatewayAbort = undefined;
    }
  }

  private async maintain(): Promise<void> {
    const revision = this.revision;
    const stale = () => this.stopped || revision !== this.revision;
    if (!this.gatewayReady()) {
      this.membersReady = false;
      this.disable();
      this.destroyConnection();
      try { await this.connectGateway(); }
      catch (error) {
        if (this.stopped) return;
        if (error instanceof RateLimitError && error.route === '/gateway/bot') {
          // A new Client has an empty rate-limit queue. Preserve Discord's wait
          // even when configure()/gateway events request an immediate retry.
          const waits = [error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(Number.isFinite);
          const retryAfterMs = Math.max(30000, ...waits);
          this.gatewayRetryAt = Date.now() + retryAfterMs;
          Object.assign(error, { code: 'DISCORD_GATEWAY_RATE_LIMITED' });
          this.log.warn({ worker: this.workerId, retryAfterMs }, 'Discord gateway rate limited; delaying next login');
        }
        // destroy() is terminal in discord.js: retries must use a fresh Client.
        const previous = this.client;
        this.currentClient = this.createClient();
        this.gatewayStarted = false;
        this.gatewayFailure = undefined;
        this.identified = false;
        this.gatewayReconnecting = false;
        await previous.destroy();
        // Configuration may change while login is pending. It must not discard
        // the cooldown or leave a terminally destroyed client for the next check.
        if (stale()) return;
        throw error;
      }
    }
    if (stale()) return;
    if (!this.gatewayReady()) return;
    if (!this.identified) {
      await this.options.onIdentity(this.client.user!.id);
      if (stale()) return;
      this.identified = true;
    }
    if (this.workerId === 1 && !this.commandsRegistered && Date.now() >= this.commandRetryAt) {
      try {
        await registerCommands(this.token, this.config.guildId, this.client.application!.id);
        this.commandsRegistered = true;
        this.log.info('Guild slash commands registered on Bot 1');
      } catch (error) {
        this.recordError(error);
        this.commandRetryAt = Date.now() + 30000;
      }
    }
    if (stale()) return;
    if (!this.channelId) { this.disable(); this.destroyConnection(); return; }
    const guild = await this.client.guilds.fetch(this.config.guildId);
    if (stale()) return;
    if (!this.membersReady) {
      const membershipRevision = this.membershipRevision;
      const role = await guild.roles.fetch(this.config.leaderRoleId, { force: true });
      if (stale()) return;
      if (!role || role.id === guild.id) throw Object.assign(new Error('LEADER_ROLE_ID must identify a role other than @everyone in this server'), { code: 'INVALID_LEADER_ROLE' });
      // Refresh only voice occupants, including after gateway resume. Never relay from an unverified cache.
      const occupants = [...guild.voiceStates.cache.values()].filter(voice => voice.channelId === this.channelId);
      const verified = await Promise.allSettled(occupants.map(voice => guild.members.fetch({ user: voice.id, force: true }).catch(error => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 10007)) throw error;
        guild.members.cache.delete(voice.id);
      })));
      if (stale()) return;
      const failed = verified.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (membershipRevision !== this.membershipRevision || !this.gatewayReady()) { this.requested = true; return; }
      this.membersReady = true;
    }
    if (!this.enabled) { this.disable(); this.destroyConnection(); this.lastError = null; return; }
    const channel = await guild.channels.fetch(this.channelId!);
    if (stale()) return;
    if (channel?.type !== ChannelType.GuildVoice) throw Object.assign(new Error('Configured channel must be a regular guild voice channel'), { code: 'INVALID_VOICE_CHANNEL' });
    const me = await guild.members.fetchMe();
    if (stale()) return;
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw Object.assign(new Error('Missing View Channel, Connect or Speak permission'), { code: 'MISSING_VOICE_PERMISSIONS' });
    }
    if (this.connection && (this.connection.state.status === VoiceConnectionStatus.Destroyed ||
      this.connection.joinConfig.channelId !== channel.id || (me.voice.channelId !== channel.id && this.connection.state.status === VoiceConnectionStatus.Ready))) {
      this.disable();
      this.destroyConnection();
    }
    if (!this.connection) {
      const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id,
        group: this.client.user!.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
      this.connection = connection;
      connection.on('error', error => { if (this.connection === connection && !this.stopped) this.audioFault(error); });
      connection.on('stateChange', (_old, next) => {
        if (this.connection !== connection || this.stopped) return;
        this.log.info({ worker: this.workerId, team: this.team, state: next.status }, 'Voice connection changed');
        if (next.status !== VoiceConnectionStatus.Ready) this.disable();
        else this.refresh();
        this.schedule(0);
      });
      connection.subscribe(this.output.player);
    }
    if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
    }
    if (stale()) return;
    this.lastError = null;
    this.refresh();
  }

  private eligibleLeaderIds(): string[] {
    if (!this.channelId || !this.membersReady || !this.gatewayReady()) return [];
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) return [];
    return [...guild.voiceStates.cache.values()].filter(voice => {
      const member = guild.members.cache.get(voice.id);
      return voice.channelId === this.channelId && member && !member.user.bot && member.roles.cache.has(this.config.leaderRoleId);
    }).map(voice => voice.id).sort();
  }

  refresh(): void {
    if (this.stopped) return;
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const ownVoice = guild?.members.me?.voice;
    const ready = this.enabled && this.identified && this.membersReady && this.gatewayReady() && this.connection?.state.status === VoiceConnectionStatus.Ready &&
      ownVoice?.channelId === this.channelId && !ownVoice.serverDeaf && !ownVoice.serverMute;
    this.router.setTransport(this.team, Boolean(ready));
    const leaderIds = ready ? this.eligibleLeaderIds() : [];
    this.router.setTeamLeaders(this.team, leaderIds);
    for (const userId of this.captures.keys()) if (!leaderIds.includes(userId)) this.stopCapture(userId);
    for (const userId of leaderIds) this.startCapture(userId);
  }

  private startCapture(userId: string): void {
    const current = this.captures.get(userId);
    if (current && this.router.isCurrent(this.team, current.epoch)) return;
    this.stopCapture(userId);
    // A destroyed receive stream remains in the receiver map until its asynchronous close event.
    if (this.connection!.receiver.subscriptions.get(userId)?.destroyed) { this.schedule(1000); return; }
    const epoch = this.router.beginSource(this.team, userId, this.channelId, false);
    if (epoch === undefined) return;
    try {
      const codec = createCodec();
      let stream: AudioReceiveStream;
      try { stream = this.connection!.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } }); }
      catch (error) { codec.close(); throw error; }
      const capture: Capture = { userId, epoch, stream, codec };
      this.captures.set(userId, capture);
      stream.on('data', (packet: Buffer) => {
        if (this.captures.get(userId) !== capture || !this.router.isCurrent(this.team, epoch)) return;
        try { this.router.push(this.team, epoch, codec.decode(packet)); }
        catch (error) { this.captureFault(capture, error); }
      });
      stream.on('error', error => this.captureFault(capture, error));
      stream.on('close', () => {
        if (this.captures.get(userId) === capture) { this.stopCapture(userId); this.schedule(1000); }
      });
    } catch (error) {
      this.router.endSource(this.team, epoch);
      this.recordError(error);
      this.schedule(1000);
    }
  }

  private captureFault(capture: Capture, error: unknown): void {
    if (this.captures.get(capture.userId) !== capture) return;
    this.recordError(error);
    this.stopCapture(capture.userId);
    // Receiver removes its subscription on close; do not resubscribe in the same turn.
    this.schedule(1000);
  }

  private stopCapture(userId?: string): void {
    if (userId === undefined) {
      for (const id of this.captures.keys()) this.stopCapture(id);
      return;
    }
    const capture = this.captures.get(userId);
    this.captures.delete(userId);
    if (!capture) return;
    this.router.endSource(this.team, capture.epoch);
    capture.stream.destroy();
    capture.codec.close();
  }

  private disable(): void {
    this.stopCapture();
    this.router.setTransport(this.team, false);
    this.router.setTeamLeaders(this.team, []);
  }
  private destroyConnection(): void {
    const connection = this.connection;
    this.connection = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
  private recordError(error: unknown): void {
    this.lastError = safeError(error);
    this.log.warn({ worker: this.workerId, team: this.team, err: error }, 'Bot operation failed');
  }
  private audioFault(error: unknown): void {
    if (this.stopped) return;
    this.recordError(error);
    this.disable();
    this.destroyConnection();
    this.schedule(1000);
  }

  status(): BotStatus<T> {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const leaderIds = this.eligibleLeaderIds();
    return {
      team: this.team, gateway: this.gatewayReady(), voice: this.connection?.state.status ?? 'offline',
      channelId: guild?.members.me?.voice.channelId ?? null,
      leaderIds, leadersKnown: this.membersReady && this.gatewayReady(), leaderPresent: leaderIds.length > 0,
      receiving: [...this.captures.values()].some(capture => this.router.isCurrent(this.team, capture.epoch)), lastError: this.lastError,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.gatewayAbort?.abort();
    this.disable();
    this.destroyConnection();
    this.output.close();
    await this.client.destroy();
  }
}
