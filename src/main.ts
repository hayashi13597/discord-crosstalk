import { generateDependencyReport } from '@discordjs/voice';
import { escapeMarkdown } from 'discord.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool, InstanceLease, migrate } from './database.js';
import { PostgresRelays } from './relay-repository.js';
import { RelayService } from './relays.js';
import { RelayRuntime } from './runtime.js';
import { createCodec } from './audio/codec.js';
import { createCommandHandler, formatLeaders } from './commands.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const pool = createPool(config.databaseUrl);
  pool.on('error', error => log.error({ err: error }, 'PostgreSQL pool error'));
  const repository = new PostgresRelays(pool, config);
  let commands: ReturnType<typeof createCommandHandler> | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = (code: number): Promise<void> => {
    if (code) process.exitCode = code;
    if (stopping) return stopping;
    stopping = (async () => {
      log.info('Stopping CrossTalk');
      const forced = setTimeout(() => { log.fatal('Shutdown timed out'); process.exit(1); }, 12000);
      forced.unref();
      commands?.stop();
      const closing = runtime.stop();
      await relays.stop();
      await closing;
      await lease.release();
      await pool.end();
      clearTimeout(forced);
      log.info('CrossTalk stopped');
    })();
    return stopping;
  };
  const fatal = (error: unknown) => {
    log.fatal({ err: error }, 'Fatal error; disabling relay');
    void shutdown(1).catch(() => process.exit(1));
  };
  const lease = new InstanceLease(pool, config.guildId, fatal);
  const runtime = new RelayRuntime(config, log, interaction => { void commands?.handle(interaction); },
    (workerId, userId) => repository.identify(workerId, userId));
  const relays = new RelayService(repository, snapshot => runtime.apply(snapshot), fatal);
  commands = createCommandHandler({ config, relays, leaders: team => runtime.workerStatus(team.workerId), onError: error => log.error({ err: error }, 'Command failed'),
    status: async groupId => {
      const snapshot = relays.snapshot;
      const lines = [`PostgreSQL: ${await repository.healthy() ? 'OK' : 'Không kết nối được'}`];
      for (const group of snapshot.groups.filter(group => !groupId || group.id === groupId)) {
        const teams = snapshot.teams.filter(team => team.groupId === group.id);
        lines.push(`${escapeMarkdown(group.name)}: ${group.state}; ${teams.length} team${runtime.groupError(group.id) ? '; lỗi AUDIO_ERROR (pause/resume để thử lại)' : ''}`);
        for (const team of teams) {
          const state = runtime.workerStatus(team.workerId);
          lines.push(`${team.legacySlot ? `Team ${team.legacySlot} ` : ''}<#${team.channelId}>; Bot ${team.workerId}: ${!state ? 'thiếu BOT_TOKEN' : `gateway ${state.gateway ? 'OK' : 'offline'}; voice ${state.voice}`}; leader ${formatLeaders(state)}; relay ${group.state === 'paused' ? 'paused' : state?.receiving ? 'sẵn sàng' : state?.leaderPresent ? 'chưa sẵn sàng' : 'chờ leader đúng kênh'}${state?.lastError ? `; lỗi ${state.lastError}` : ''}`);
        }
      }
      if (!groupId) {
        for (const worker of config.workers.filter(worker => !snapshot.teams.some(team => team.workerId === worker.id))) {
          const state = runtime.workerStatus(worker.id);
          lines.push(`Bot ${worker.id}: ${worker.id <= 3 ? 'giữ cho team cũ' : 'trống'}; gateway ${state?.gateway ? 'OK' : 'offline'}${state?.lastError ? `; lỗi ${state.lastError}` : ''}`);
        }
      }
      return lines.join('\n');
    },
  });
  process.once('SIGTERM', () => { void shutdown(0).catch(fatal); });
  process.once('SIGINT', () => { void shutdown(0).catch(fatal); });
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  try {
    log.info({ dependencies: generateDependencyReport() }, 'Checking voice dependencies');
    const codec = createCodec();
    codec.close();
    await lease.acquire();
    if (stopping) return;
    await migrate(pool);
    if (stopping) return;
    await relays.initialize();
    if (stopping) return;
    runtime.start();
    log.info('CrossTalk started; relay groups and bot connections are supervised independently');
  } catch (error) {
    if (stopping) { await stopping; return; }
    log.fatal({ err: error }, 'Startup failed');
    await shutdown(1);
  }
}

void main().catch(() => { console.error('CrossTalk could not start. Check required configuration and dependencies.'); process.exitCode = 1; });
