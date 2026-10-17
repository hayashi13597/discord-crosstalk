import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool, InstanceLease, migrate, PostgresLeaders } from './database.js';
import { LeaderService } from './leaders.js';
import { AudioRouter } from './audio/router.js';
import { createCodec } from './audio/codec.js';
import { createCommandHandler } from './commands.js';
import { TeamBot } from './bot.js';
import { TEAMS, type Team } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  const pool = createPool(config.databaseUrl);
  pool.on('error', error => log.error({ err: error }, 'PostgreSQL pool error'));
  const router = new AudioRouter(Object.fromEntries(TEAMS.map(t => [t, config.bots[t].channelId])) as Record<Team, string>, config);
  const repository = new PostgresLeaders(pool, config.guildId);
  const bots: TeamBot[] = [];
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
      // Stop voice immediately, even while an in-flight DB command is finishing.
      const closingBots = bots.map(bot => bot.stop());
      router.stop();
      await leaders.stop();
      await Promise.allSettled(closingBots);
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
  const leaders = new LeaderService(repository, snapshot => {
    try {
      router.setLeaders(snapshot);
      // refresh must observe the just-committed snapshot, before LeaderService publishes it.
      activeLeaders = snapshot;
      for (const bot of bots) bot.refresh();
    } catch (error) { fatal(error); throw error; }
  }, fatal);
  let activeLeaders = leaders.snapshot;
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
    await leaders.initialize();
    if (stopping) return;
    for (const team of TEAMS) bots.push(new TeamBot(team, config, router, () => activeLeaders, log, interaction => {
      if (team === 1 && interaction.isChatInputCommand()) void commands!.handle(interaction);
    }));
    commands = createCommandHandler({ config, leaders, onError: error => log.error({ err: error }, 'Command failed'),
      status: async () => {
        const databaseHealthy = await repository.healthy();
        return [`PostgreSQL: ${databaseHealthy ? 'OK' : 'Không kết nối được'}`, ...bots.map(bot => {
          const state = bot.status();
          const leader = activeLeaders[bot.team];
          return `Team ${bot.team}: gateway ${state.gateway ? 'OK' : 'offline'}; voice ${state.voice}; channel ${state.channelId ? `<#${state.channelId}>` : '—'}; leader ${leader ? `<@${leader}>` : 'Chưa có'}; relay ${state.receiving ? 'sẵn sàng' : state.leaderPresent ? 'chưa sẵn sàng' : 'chờ leader đúng kênh'}${state.lastError ? `; lỗi ${state.lastError}` : ''}`;
        })].join('\n');
      },
    });
    router.start();
    for (const bot of bots) bot.start();
    log.info('CrossTalk started; bot connections are supervised independently');
  } catch (error) {
    if (stopping) { await stopping; return; }
    log.fatal({ err: error }, 'Startup failed');
    await shutdown(1);
  }
}

// Configuration errors report variable names, never their values.
void main().catch(() => { console.error('CrossTalk could not start. Check required configuration and dependencies.'); process.exitCode = 1; });
