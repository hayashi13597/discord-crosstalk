import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

// A checked-out client owns the connection until release: async repository work
// cannot interleave transactions on the single SQLite connection.
export interface LocalClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  release(): void;
}
interface CachedStatement {
  statement: StatementSync;
  indices: number[];
  returnsRows: boolean;
}
const MIGRATION_FILES = [
  '001_sqlite.sql',
  '002_sqlite_cleanup.sql',
  '003_voice_move_settings.sql',
  '004_voice_move_sources.sql',
  '005_voice_move_verification.sql',
  '006_relay_session.sql',
] as const;

export class LocalDatabase {
  readonly path: string;
  private db?: DatabaseSync;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private statements = new Map<string, CachedStatement>();
  constructor(path: string) {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    closeSync(openSync(resolved, 'a', 0o600));
    this.path = realpathSync(resolved);
  }
  private ensureOpen(): DatabaseSync {
    if (this.closed) throw new Error('SQLite database is closed');
    if (this.db) return this.db;
    const db = new DatabaseSync(this.path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
    this.db = db;
    return db;
  }
  private prepareCached(db: DatabaseSync, sql: string): CachedStatement {
    let cached = this.statements.get(sql);
    if (cached) return cached;
    if (this.statements.size >= 128) this.statements.clear();
    const indices: number[] = [];
    const seen = new Set<number>();
    const translated = sql.replace(/\$(\d+)/g, (_, raw: string) => {
      const index = Number(raw);
      if (!seen.has(index)) { seen.add(index); indices.push(index); }
      return `:p${index}`;
    });
    const statement = db.prepare(translated);
    cached = { statement, indices, returnsRows: statement.columns().length > 0 };
    this.statements.set(sql, cached);
    return cached;
  }
  async connect(): Promise<LocalClient> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    let db: DatabaseSync;
    try { db = this.ensureOpen(); }
    catch (error) { unlock(); throw error; }
    let released = false;
    return {
      query: async (sql, params = []) => {
        if (released) throw new Error('SQLite client already released');
        const { statement, indices, returnsRows } = this.prepareCached(db, sql);
        const bindings: Record<string, SQLInputValue> = {};
        for (const index of indices) {
          const raw = params[index - 1];
          bindings[`p${index}`] = raw === undefined ? null : typeof raw === 'boolean' ? (raw ? 1 : 0) : raw as SQLInputValue;
        }
        if (returnsRows) {
          const rows = indices.length ? statement.all(bindings) : statement.all();
          return { rows, rowCount: rows.length };
        }
        const result = indices.length ? statement.run(bindings) : statement.run();
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
    const migrations = await Promise.all(MIGRATION_FILES.map(async (file, index) => ({
      version: index + 1, sql: await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
    })));
    const client = await this.connect();
    const db = this.ensureOpen();
    try {
      this.statements.clear();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);');
      for (const { version, sql } of migrations) {
        if (!db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version)) {
          db.exec(sql);
          db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version);
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { this.statements.clear(); client.release(); }
  }
  async end(): Promise<void> {
    await this.tail;
    this.closed = true;
    this.statements.clear();
    this.db?.close();
    this.db = undefined;
  }
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
