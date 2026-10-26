import { migrate, pool } from './db.js';

await migrate();
console.log('schema applied');
await pool.end();
