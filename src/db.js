import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

export async function migrate() {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

/**
 * Write a fired run and its items.
 *
 * The run record is the lock. A draw date already marked fired or complete is
 * not reopened here: late items go down the amend path instead, so a second
 * batch can never quietly create a duplicate post set.
 */
export async function saveRun({ drawDate, items, startsAt, endsAt }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, status FROM draw_runs WHERE draw_date = $1 FOR UPDATE',
      [drawDate],
    );

    if (existing.rowCount && existing.rows[0].status !== 'collecting') {
      await client.query('ROLLBACK');
      return { runId: existing.rows[0].id, status: existing.rows[0].status, amend: true };
    }

    const run = await client.query(
      `INSERT INTO draw_runs (draw_date, status, starts_at, ends_at, fired_at)
       VALUES ($1, 'fired', $2, $3, now())
       ON CONFLICT (draw_date) DO UPDATE
         SET status = 'fired', starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at, fired_at = now()
       RETURNING id`,
      [drawDate, startsAt, endsAt],
    );
    const runId = run.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO draw_items
           (run_id, pid, raw_title, product_name, price_display, price_cents, image_url, classification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (run_id, pid) DO UPDATE
           SET raw_title = EXCLUDED.raw_title, product_name = EXCLUDED.product_name,
               price_display = EXCLUDED.price_display, price_cents = EXCLUDED.price_cents,
               image_url = EXCLUDED.image_url, classification = EXCLUDED.classification`,
        [runId, it.pid, it.rawTitle, it.productName, it.priceDisplay,
         it.priceCents, it.imageUrl, it.classification],
      );
    }

    await client.query('COMMIT');
    return { runId, status: 'fired', amend: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markError(runId, message) {
  await pool.query('UPDATE draw_runs SET status = $2, error = $3 WHERE id = $1',
    [runId, 'error', String(message).slice(0, 2000)]);
}

/**
 * Store an image and return its id.
 *
 * The id is a content hash, so the same bytes always produce the same URL and
 * storing twice is free. It also means a URL can never silently start pointing
 * at a different picture.
 */
export async function storeImage(buffer, { runId = null, pid = null, kind = 'product', mime = 'image/png', width = null, height = null } = {}) {
  const id = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  await pool.query(
    `INSERT INTO draw_images (id, run_id, pid, kind, mime, bytes, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET run_id = COALESCE(EXCLUDED.run_id, draw_images.run_id)`,
    [id, runId, pid, kind, mime, buffer, width, height],
  );
  return id;
}

export async function getImage(id) {
  const { rows } = await pool.query('SELECT bytes, mime FROM draw_images WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function setRunImage(runId, imageUrl) {
  await pool.query('UPDATE draw_runs SET image_url = $2 WHERE id = $1', [runId, imageUrl]);
}

export async function getSecret(key) {
  const { rows } = await pool.query('SELECT value FROM secrets WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setSecret(key, value) {
  await pool.query(
    `INSERT INTO secrets (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function deleteSecret(key) {
  await pool.query('DELETE FROM secrets WHERE key = $1', [key]);
}
