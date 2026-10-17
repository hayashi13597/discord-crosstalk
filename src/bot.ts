import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits, type Interaction } from 'discord.js';
import { entersState, EndBehaviorType, joinVoiceChannel, VoiceConnectionStatus,
  type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { createCodec, type Codec } from './audio/codec.js';
import { AudioRouter } from './audio/router.js';
import { VoiceOutput } from './audio/output.js';
import { registerCommands } from './commands.js';
import { safeError } from './logger.js';
import type { Team } from './types.js';

export interface BotStatus<T = Team> {
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

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Discord operation timed out')), ms);
    })]);
  } finally { clearTimeout(timeout); }
}

export interface WorkerOptions {
  workerId: number;
  token: string;
  channelId: string | null;
  active: boolean;
  onIdentity: (userId: string) => Promise<void>;
}

export class TeamBot<T extends string | number = Team> {
  private currentClient: Client;
  get client(): Client { return this.currentClient; }
  readonly output: VoiceOutput;
  private connection?: VoiceConnection;
  private capture?: Capture;
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

  private revision = 0;
  private identified = false;
  private get workerId(): number { return this.options?.workerId ?? Number(this.team); }
  private get token(): string { return this.options?.token ?? this.config.bots[this.team as Team].token; }
  private get channelId(): string | null { return this.options ? this.options.channelId : this.config.bots[this.team as Team].channelId; }
  private get enabled(): boolean { return this.options ? this.options.active && this.channelId !== null : true; }

  constructor(public team: T, private config: Config, private router: AudioRouter<T>,
    private getLeaders: () => Record<T, string | null>, private log: Logger,
    private onInteraction?: (interaction: Interaction) => void, private options?: WorkerOptions) {
    this.currentClient = this.createClient();
    this.output = new VoiceOutput(error => this.audioFault(error));
    if (this.channelId) router.attach(team, this.output);
  }

  configure(team: T, router: AudioRouter<T>, getLeaders: () => Record<T, string | null>, channelId: string | null, active: boolean): void {
    if (!this.options || this.stopped) return;
    ++this.revision;
    this.disable();
    this.destroyConnection();
    this.router.detach(this.team);
    this.team = team;
    this.router = router;
    this.getLeaders = getLeaders;
    this.options.channelId = channelId;
    this.options.active = active;
    if (channelId) router.attach(team, this.output);
    this.schedule(0);
  }

  private createClient(): Client {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      rest: { timeout: 15000 } });
    const active = () => this.currentClient === client && !this.stopped;
    const error = (error: Error) => { if (active()) this.recordError(error); };
    const disconnected = () => {
      if (!active()) return;
      this.gatewayReconnecting = true;
      this.disable();
      this.schedule(0);
    };
    const ready = () => {
      if (!active()) return;
      this.gatewayReconnecting = false;
      this.schedule(0);
    };
    client.on(Events.Error, error);
    client.on(Events.ShardError, error);
    client.on(Events.ShardDisconnect, disconnected);
    client.on(Events.ShardReconnecting, disconnected);
    client.on(Events.ClientReady, ready);
    client.on(Events.ShardReady, ready);
    client.on(Events.ShardResume, ready);
    client.on(Events.InteractionCreate, interaction => { if (active()) this.onInteraction?.(interaction); });
    client.on(Events.VoiceStateUpdate, (before, after) => {
      if (!active()) return;
      if (after.guild.id !== this.config.guildId) return;
      const leaderId = this.getLeaders()[this.team];
      if (after.id === leaderId || before.id === leaderId || after.id === this.client.user?.id) {
        this.refresh();
        this.schedule(0);
      }
    });
    return client;
  }

  start(): void { this.schedule(0); }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.running) { this.requested = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.check(); }, ms);
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
    const abort = new AbortController();
    this.gatewayAbort = abort;
    let checkReady!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      checkReady = () => { if (this.gatewayReady()) resolve(); };
      client.on(Events.ClientReady, checkReady);
      client.on(Events.ShardReady, checkReady);
      client.on(Events.ShardResume, checkReady);
      abort.signal.addEventListener('abort', () => reject(new Error('Discord gateway wait cancelled')), { once: true });
    });
    try {
      // login() can resolve before guilds are available. Register readiness listeners first.
      // During a reconnect, let discord.js resume its existing session instead of logging in again.
      let login = Promise.resolve();
      if (!this.gatewayStarted) {
        this.gatewayStarted = true;
        login = Promise.resolve().then(async () => {
          if (this.stopped) return;
          await client.login(this.token);
          if (this.stopped || this.client !== client) await client.destroy();
        });
      }
      await deadline(Promise.all([ready, login.then(checkReady)]), 30000);
    } finally {
      client.off(Events.ClientReady, checkReady);
      client.off(Events.ShardReady, checkReady);
      client.off(Events.ShardResume, checkReady);
      abort.abort();
      if (this.gatewayAbort === abort) this.gatewayAbort = undefined;
    }
  }

  private async maintain(): Promise<void> {
    const revision = this.revision;
    const stale = () => this.stopped || revision !== this.revision;
    if (!this.gatewayReady()) {
      this.disable();
      this.destroyConnection();
      try { await this.connectGateway(); }
      catch (error) {
        if (stale()) return;
        // destroy() is terminal in discord.js: retries must use a fresh Client.
        const previous = this.client;
        this.currentClient = this.createClient();
        this.gatewayStarted = false;
        this.identified = false;
        this.gatewayReconnecting = false;
        await previous.destroy();
        throw error;
      }
    }
    if (stale()) return;
    if (!this.gatewayReady()) return;
    if (!this.identified) {
      await this.options?.onIdentity(this.client.user!.id);
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
    if (!this.enabled) { this.disable(); this.destroyConnection(); return; }
    const guild = await this.client.guilds.fetch(this.config.guildId);
    if (stale()) return;
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
    const leaderId = this.getLeaders()[this.team];
    if (leaderId && !this.client.users.cache.has(leaderId)) {
      // A single-member fetch needs no Guild Members privileged intent.
      await guild.members.fetch(leaderId).catch(error => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 10007)) throw error;
      });
    }
    if (stale()) return;
    this.lastError = null;
    this.refresh();
  }

  refresh(): void {
    if (this.stopped) return;
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const ownVoice = guild?.members.me?.voice;
    const ready = this.enabled && this.identified && this.gatewayReady() && this.connection?.state.status === VoiceConnectionStatus.Ready &&
      ownVoice?.channelId === this.channelId && !ownVoice.serverDeaf && !ownVoice.serverMute;
    this.router.setTransport(this.team, Boolean(ready));
    const userId = this.getLeaders()[this.team];
    const voice = userId ? guild?.voiceStates.cache.get(userId) : undefined;
    const user = userId ? this.client.users.cache.get(userId) : undefined;
    const eligible = ready && userId && user && !user.bot && voice?.channelId === this.channelId;
    if (!eligible) { this.stopCapture(); return; }
    if (this.capture?.userId === userId && this.router.isCurrent(this.team, this.capture.epoch)) return;
    this.stopCapture();
    // A destroyed receive stream remains in the receiver map until its asynchronous close event.
    if (this.connection!.receiver.subscriptions.get(userId)?.destroyed) { this.schedule(1000); return; }
    const epoch = this.router.beginSource(this.team, userId, voice.channelId, user.bot);
    if (epoch === undefined) return;
    try {
      const codec = createCodec();
      let stream: AudioReceiveStream;
      try { stream = this.connection!.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } }); }
      catch (error) { codec.close(); throw error; }
      const capture: Capture = { userId, epoch, stream, codec };
      this.capture = capture;
      stream.on('data', (packet: Buffer) => {
        if (this.capture !== capture || !this.router.isCurrent(this.team, epoch)) return;
        try { this.router.push(this.team, epoch, codec.decode(packet)); }
        catch (error) { this.captureFault(capture, error); }
      });
      stream.on('error', error => this.captureFault(capture, error));
      stream.on('close', () => {
        if (this.capture === capture) { this.stopCapture(); this.schedule(1000); }
      });
    } catch (error) {
      this.router.endSource(this.team, epoch);
      this.recordError(error);
      this.schedule(1000);
    }
  }

  private captureFault(capture: Capture, error: unknown): void {
    if (this.capture !== capture) return;
    this.recordError(error);
    this.stopCapture();
    // Receiver removes its subscription on close; do not resubscribe in the same turn.
    this.schedule(1000);
  }

  private stopCapture(): void {
    const capture = this.capture;
    this.capture = undefined;
    if (!capture) return;
    this.router.endSource(this.team, capture.epoch);
    capture.stream.destroy();
    capture.codec.close();
  }

  private disable(): void {
    this.stopCapture();
    this.router.setTransport(this.team, false);
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
    const leaderId = this.getLeaders()[this.team];
    return {
      team: this.team, gateway: this.gatewayReady(), voice: this.connection?.state.status ?? 'offline',
      channelId: guild?.members.me?.voice.channelId ?? null,
      leaderPresent: Boolean(leaderId && guild?.voiceStates.cache.get(leaderId)?.channelId === this.channelId),
      receiving: Boolean(this.capture && this.router.isCurrent(this.team, this.capture.epoch)), lastError: this.lastError,
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
