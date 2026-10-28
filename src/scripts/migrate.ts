import { LocalDatabase, LocalInstanceLease } from '../sqlite.js';
const db = new LocalDatabase(process.env.DATABASE_PATH?.trim() || './data/crosstalk.sqlite');
const lease = new LocalInstanceLease(db, error => { console.error(error); process.exit(1); });
try { await lease.acquire(); await db.migrate(); console.log('SQLite migrations applied.'); }
catch (error) { console.error('Migration failed:', error); process.exitCode = 1; }
finally { await db.end(); await lease.release(); }
