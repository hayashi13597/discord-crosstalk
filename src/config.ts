import { TEAMS, type Team } from './types.js';

export interface Config {
  guildId: string;
  bots: Record<Team, { token: string; channelId: string }>;
  databaseUrl: string;
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
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const id = (key: string) => {
    const value = required(key);
    if (!snowflake.test(value)) throw new Error(`Invalid Discord ID: ${key}`);
    return value;
  };
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const bots = Object.fromEntries(TEAMS.map(team => [team, {
    token: required(`BOT_TOKEN_${team}`), channelId: id(`VOICE_CHANNEL_ID_${team}`),
  }])) as Config['bots'];
  if (new Set(TEAMS.map(t => bots[t].token)).size !== 3) throw new Error('Bot tokens must be distinct');
  if (new Set(TEAMS.map(t => bots[t].channelId)).size !== 3) throw new Error('Voice channels must be distinct');
  const databaseUrl = required('DATABASE_URL');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const adminRoleIds = (env.ADMIN_ROLE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminRoleIds.some(role => !snowflake.test(role))) throw new Error('Invalid ADMIN_ROLE_IDS');
  const jitterMs = number('JITTER_BUFFER_MS', 60, 0, 500);
  const maxQueueMs = number('MAX_QUEUE_MS', 200, 20, 1000);
  if (jitterMs % 20 || maxQueueMs % 20 || jitterMs >= maxQueueMs) {
    throw new Error('Buffer sizes must be multiples of 20ms; jitter must be below max queue');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new Error('Invalid LOG_LEVEL');
  return {
    guildId: id('GUILD_ID'), bots, databaseUrl, adminRoleIds, jitterMs, maxQueueMs,
    singleGain: number('SINGLE_SOURCE_GAIN', 1, 0, 2),
    mixGain: number('MIX_SOURCE_GAIN', 0.5, 0, 1), logLevel,
  };
}
