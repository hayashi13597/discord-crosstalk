import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

// A checked-out client owns the connection until release: async repository work
// cannot interleave transactions on the single SQLite connection.
export interface LocalClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  release(): void;
}
export class LocalDatabase {
  readonly path: string;
  private db: DatabaseSync;
  private tail: Promise<void> = Promise.resolve();
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.path = realpathSync(this.path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  async connect(): Promise<LocalClient> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    let released = false;
    return {
      query: async (sql, params = []) => {
        if (released) throw new Error('SQLite client already released');
        const bindings: Record<string, SQLInputValue> = {};
        const statement = this.db.prepare(sql.replace(/\$(\d+)/g, (_, index: string) => {
          const value = params[Number(index) - 1];
          bindings[`p${index}`] = value === undefined ? null : value as SQLInputValue;
          return `:p${index}`;
        }));
        if (statement.columns().length) {
          const rows = statement.all(bindings);
          return { rows, rowCount: rows.length };
        }
        const result = statement.run(bindings);
        return { rows: [], rowCount: Number(result.changes) };
      },
      release: () => { if (!released) { released = true; unlock(); } },
    };
  }
  async query(sql: string, params?: unknown[]) {
    const client = await this.connect();
    try { return await client.query(sql, params); } finally { client.release(); }
  }
  async migrate(): Promise<void> {
    const migrations = await Promise.all(['001_sqlite.sql', '002_sqlite_cleanup.sql', '003_voice_move_settings.sql', '004_voice_move_sources.sql', '005_voice_move_verification.sql'].map(async (file, index) => ({
      version: index + 1, sql: await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
    })));
    const client = await this.connect();
    try {
      this.db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);');
      for (const { version, sql } of migrations) {
        if (!this.db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version)) {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async end(): Promise<void> { await this.tail; this.db.close(); }
}

export class LocalInstanceLease {
  private unlock?: () => Promise<void>;
  private closing = false;
  constructor(private db: LocalDatabase, private onLost: (error: unknown) => void) {}
  async acquire(): Promise<void> {
    if (this.closing) throw new Error('Instance lease acquisition canceled');
    const unlock = await lockfile.lock(this.db.path, {
      stale: 15000, update: 5000, retries: 0, onCompromised: this.onLost,
    });
    if (this.closing) { await unlock(); throw new Error('Instance lease acquisition canceled'); }
    this.unlock = unlock;
  }
  async release(): Promise<void> {
    this.closing = true;
    const unlock = this.unlock;
    this.unlock = undefined;
    await unlock?.();
  }
}
