import { createPool, migrate } from '../database.js';

if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
const pool = createPool(process.env.DATABASE_URL);
try { await migrate(pool); console.log('Database migrations applied.'); }
catch { console.error('Migration failed. Check database connectivity and permissions.'); process.exitCode = 1; }
finally { await pool.end(); }
