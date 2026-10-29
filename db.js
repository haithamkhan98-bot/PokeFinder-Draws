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

export async function setRunDesign(runId, designId) {
  await pool.query('UPDATE draw_runs SET canva_design_id = $2 WHERE id = $1', [runId, designId]);
}

export async function recordBufferPost({ runId, slot, channelId, bufferPostId }) {
  await pool.query(
    `INSERT INTO buffer_posts (run_id, slot, channel_id, buffer_post_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (run_id, slot, channel_id) DO UPDATE SET buffer_post_id = EXCLUDED.buffer_post_id`,
    [runId, slot, channelId, bufferPostId],
  );
}

export async function markComplete(runId) {
  await pool.query("UPDATE draw_runs SET status = 'complete', completed_at = now() WHERE id = $1", [runId]);
}

export async function scheduleDiscordPost({ runId, slot, channelId, dueAt, body }) {
  await pool.query(
    `INSERT INTO discord_posts (run_id, slot, channel_id, due_at, body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (run_id, slot) DO UPDATE
       SET due_at = EXCLUDED.due_at, body = EXCLUDED.body, channel_id = EXCLUDED.channel_id`,
    [runId, slot, channelId, dueAt, body],
  );
}

/**
 * Claim the Discord posts that are due.
 *
 * SKIP LOCKED means two instances of the bot, which Railway can briefly run
 * during a deploy, cannot both grab the same row and post it twice.
 */
export async function claimDueDiscordPosts({ limit = 5 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, run_id, slot, channel_id, body, attempts
       FROM discord_posts
      WHERE posted_at IS NULL AND due_at <= now() AND attempts < 5
      ORDER BY due_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function markDiscordPosted(id, messageId) {
  await pool.query(
    'UPDATE discord_posts SET posted_at = now(), message_id = $2, error = NULL WHERE id = $1',
    [id, messageId],
  );
}

export async function markDiscordFailed(id, message) {
  await pool.query(
    'UPDATE discord_posts SET attempts = attempts + 1, error = $2 WHERE id = $1',
    [id, String(message).slice(0, 500)],
  );
}

/** Write a fired queue run and its items. Mirrors saveRun for draws. */
export async function saveQueueRun({ dropDate, dropsAt, items }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, status FROM queue_runs WHERE drop_date = $1 FOR UPDATE', [dropDate],
    );
    if (existing.rowCount && existing.rows[0].status !== 'collecting') {
      await client.query('ROLLBACK');
      return { runId: existing.rows[0].id, status: existing.rows[0].status, amend: true };
    }
    const run = await client.query(
      `INSERT INTO queue_runs (drop_date, status, drops_at, fired_at)
       VALUES ($1, 'fired', $2, now())
       ON CONFLICT (drop_date) DO UPDATE
         SET status = 'fired', drops_at = EXCLUDED.drops_at, fired_at = now()
       RETURNING id`,
      [dropDate, dropsAt],
    );
    const runId = run.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO queue_items
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

export async function setQueueRunResult(runId, { headline, imageUrl }) {
  await pool.query(
    'UPDATE queue_runs SET headline = COALESCE($2, headline), image_url = COALESCE($3, image_url) WHERE id = $1',
    [runId, headline ?? null, imageUrl ?? null],
  );
}

export async function recordQueuePost({ runId, slot, channelId, bufferPostId }) {
  await pool.query(
    `INSERT INTO queue_posts (run_id, slot, channel_id, buffer_post_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (run_id, slot, channel_id) DO UPDATE SET buffer_post_id = EXCLUDED.buffer_post_id`,
    [runId, slot, channelId, bufferPostId],
  );
}

/** The draw run's closing posts for a given date, if one exists and has not sent. */
export async function drawOverPostsOn(date) {
  const { rows } = await pool.query(
    `SELECT bp.buffer_post_id, bp.channel_id
       FROM buffer_posts bp
       JOIN draw_runs dr ON dr.id = bp.run_id
      WHERE dr.draw_date = $1 AND bp.slot = 'over'`,
    [date],
  );
  return rows;
}

/** A fired queue run on a given date, with its items in stored order. */
export async function queueRunOn(date) {
  const { rows } = await pool.query(
    'SELECT id, drops_at FROM queue_runs WHERE drop_date = $1 AND status <> $2', [date, 'collecting'],
  );
  if (!rows.length) return null;
  const items = await pool.query(
    `SELECT pid, raw_title, product_name, price_display, price_cents, classification
       FROM queue_items WHERE run_id = $1 ORDER BY id`,
    [rows[0].id],
  );
  return {
    runId: rows[0].id,
    dropsAt: rows[0].drops_at,
    items: items.rows.map((r) => ({
      pid: r.pid,
      rawTitle: r.raw_title,
      productName: r.product_name,
      postName: r.product_name,
      priceDisplay: r.price_display,
      priceCents: r.price_cents,
      classification: r.classification,
    })),
  };
}
