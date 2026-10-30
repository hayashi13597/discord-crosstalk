export class ConfigError extends Error {}

export interface Config {
  guildId: string;
  leaderRoleId: string;
  workers: { id: number; token: string }[];
  databasePath: string;
  adminRoleIds: string[];
  jitterMs: number;
  maxQueueMs: number;
  singleGain: number;
  mixGain: number;
  logLevel: string;
}

const snowflake = /^\d{17,20}$/;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigError(`Missing ${key}`);
    return value;
  };
  const id = (key: string) => {
    const value = required(key);
    if (!snowflake.test(value)) throw new ConfigError(`Invalid Discord ID: ${key}`);
    return value;
  };
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new ConfigError(`Invalid ${key}`);
    return value;
  };
  for (const workerId of [1, 2, 3]) required(`BOT_TOKEN_${workerId}`);
  const workers = Object.keys(env).filter(key => /^BOT_TOKEN_[1-9]\d*$/.test(key) && env[key]?.trim())
    .map(key => ({ id: Number(key.slice(10)), token: required(key) })).sort((a, b) => a.id - b.id);
  if (workers.some(worker => !Number.isSafeInteger(worker.id))) throw new ConfigError('Invalid worker ID');
  if (new Set(workers.map(worker => worker.token)).size !== workers.length) throw new ConfigError('Bot tokens must be distinct');
  const databasePath = env.DATABASE_PATH === undefined ? './data/crosstalk.sqlite' : env.DATABASE_PATH.trim();
  if (!databasePath || databasePath === ':memory:') throw new ConfigError('DATABASE_PATH must be a persistent file path');
  const adminRoleIds = (env.ADMIN_ROLE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminRoleIds.some(role => !snowflake.test(role))) throw new ConfigError('Invalid ADMIN_ROLE_IDS');
  const jitterMs = number('JITTER_BUFFER_MS', 60, 0, 500);
  const maxQueueMs = number('MAX_QUEUE_MS', 200, 20, 1000);
  if (jitterMs % 20 || maxQueueMs % 20 || jitterMs >= maxQueueMs) {
    throw new ConfigError('Buffer sizes must be multiples of 20ms; jitter must be below max queue');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new ConfigError('Invalid LOG_LEVEL');
  return {
    guildId: id('GUILD_ID'), leaderRoleId: id('LEADER_ROLE_ID'), workers, databasePath, adminRoleIds, jitterMs, maxQueueMs,
    singleGain: number('SINGLE_SOURCE_GAIN', 1, 0, 2),
    mixGain: number('MIX_SOURCE_GAIN', 0.5, 0, 1), logLevel,
  };
}
