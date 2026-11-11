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

export async function scheduleDiscordPost({ runId, slot, channelId, dueAt, body, imageUrl = null }) {
  await pool.query(
    `INSERT INTO discord_posts (run_id, slot, channel_id, due_at, body, image_url)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id, slot) DO UPDATE
       SET due_at = EXCLUDED.due_at, body = EXCLUDED.body,
           channel_id = EXCLUDED.channel_id, image_url = EXCLUDED.image_url`,
    [runId, slot, channelId, dueAt, body, imageUrl],
  );
}

/**
 * Claim the Discord posts that are due.
 *
 * SKIP LOCKED means two instances of the bot, which Railway can briefly run
 * during a deploy, cannot both grab the same row and post it twice.
 */
/**
 * The two Discord queues, by the `source` every claimed row carries.
 *
 * Walmart draws and Target raffles keep separate tables because each one's
 * run_id is a foreign key into its own runs table. The source travels with the
 * row so the scheduler marks the right one posted, and a wrong source can only
 * come from code in this file rather than from a caller.
 */
const DISCORD_TABLES = {
  walmart: 'discord_posts',
  target: 'target_discord_posts',
};

function discordTable(source) {
  const table = DISCORD_TABLES[source];
  if (!table) throw new Error(`unknown discord post source: ${source}`);
  return table;
}

/**
 * Claim the Discord posts that are due, across both queues.
 *
 * SKIP LOCKED means two instances of the bot, which Railway can briefly run
 * during a deploy, cannot both grab the same row and post it twice. Each queue
 * is claimed in its own statement: Postgres will not take FOR UPDATE on a
 * UNION, and two small indexed queries are cheaper than being clever.
 */
export async function claimDueDiscordPosts({ limit = 5 } = {}) {
  const out = [];
  for (const source of Object.keys(DISCORD_TABLES)) {
    const { rows } = await pool.query(
      `SELECT id, run_id, slot, channel_id, body, image_url, attempts
         FROM ${discordTable(source)}
        WHERE posted_at IS NULL AND due_at <= now() AND attempts < 5
        ORDER BY due_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    out.push(...rows.map((r) => ({ ...r, source })));
  }
  return out;
}

export async function markDiscordPosted(id, messageId, source = 'walmart') {
  await pool.query(
    `UPDATE ${discordTable(source)} SET posted_at = now(), message_id = $2, error = NULL WHERE id = $1`,
    [id, messageId],
  );
}

export async function markDiscordFailed(id, message, source = 'walmart') {
  await pool.query(
    `UPDATE ${discordTable(source)} SET attempts = attempts + 1, error = $2 WHERE id = $1`,
    [id, String(message).slice(0, 500)],
  );
}

/** Queue a member facing Discord post for a Target raffle run. */
export async function scheduleTargetDiscordPost({ runId, slot, channelId, dueAt, body, imageUrl = null }) {
  await pool.query(
    `INSERT INTO target_discord_posts (run_id, slot, channel_id, due_at, body, image_url)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id, slot) DO UPDATE
       SET due_at = EXCLUDED.due_at, body = EXCLUDED.body,
           channel_id = EXCLUDED.channel_id, image_url = EXCLUDED.image_url`,
    [runId, slot, channelId, dueAt, body, imageUrl],
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

/**
 * Record one BestBuy Daily Summary item against the morning it will post in.
 *
 * The monitor sometimes repeats a product. An existing SKU in the same run is
 * updated rather than duplicated, so the last numbers seen are the ones used.
 */
export async function recordBestbuyItem({ postDate, postAt, item }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO bestbuy_runs (post_date, post_at) VALUES ($1, $2)
       ON CONFLICT (post_date) DO UPDATE SET post_date = EXCLUDED.post_date
       RETURNING id, posted_at`,
      [postDate, postAt],
    );
    const { id: runId, posted_at: postedAt } = run.rows[0];
    const { rows } = await client.query(
      `INSERT INTO bestbuy_items
         (run_id, sku, raw_title, price_display, link, image_url, units, states, stock, regions, merch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (run_id, sku) DO UPDATE SET
         raw_title = EXCLUDED.raw_title, price_display = EXCLUDED.price_display,
         link = EXCLUDED.link, image_url = EXCLUDED.image_url, units = EXCLUDED.units,
         states = EXCLUDED.states, stock = EXCLUDED.stock, regions = EXCLUDED.regions,
         merch = EXCLUDED.merch, seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [runId, item.sku, item.rawTitle, item.priceDisplay, item.link, item.imageUrl,
        item.units, item.states, JSON.stringify(item.stock), JSON.stringify(item.regions), item.merch],
    );
    await client.query('COMMIT');
    // `late` means the digest for this morning has already gone out.
    return { runId, inserted: rows[0].inserted, late: Boolean(postedAt) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The run whose 7AM slot has come round, with its items. */
export async function claimDueBestbuyRun() {
  const { rows } = await pool.query(
    `SELECT id, post_date, post_at, attempts
       FROM bestbuy_runs
      WHERE posted_at IS NULL AND post_at <= now() AND attempts < 5
      ORDER BY post_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
  );
  if (!rows.length) return null;
  const run = rows[0];
  const items = await pool.query(
    `SELECT sku, raw_title AS "rawTitle", price_display AS "priceDisplay", link,
            image_url AS "imageUrl", units, states, stock, regions, merch
       FROM bestbuy_items WHERE run_id = $1 ORDER BY units DESC`,
    [run.id],
  );
  return { ...run, items: items.rows };
}

export async function markBestbuyPosted(id, { messageId, body, form }) {
  await pool.query(
    `UPDATE bestbuy_runs
        SET posted_at = now(), message_id = $2, body = $3, form = $4, error = NULL
      WHERE id = $1`,
    [id, messageId, body, form],
  );
}

/** Returns the new attempt count so the caller can say when it has given up. */
export async function markBestbuyFailed(id, message) {
  const { rows } = await pool.query(
    `UPDATE bestbuy_runs SET attempts = attempts + 1, error = $2
      WHERE id = $1 RETURNING attempts`,
    [id, String(message).slice(0, 500)],
  );
  return rows[0]?.attempts ?? 0;
}

/** Clear the attempt count so a run the ticker gave up on can be retried. */
export async function retryBestbuyRun(id) {
  const { rows } = await pool.query(
    `UPDATE bestbuy_runs SET attempts = 0, error = NULL
      WHERE id = $1 AND posted_at IS NULL RETURNING id, post_date`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The most recent unposted BestBuy run and its items, due or not.
 *
 * Newest first, not oldest. An old run that failed its attempts used to sit
 * at the front of this queue forever and make every preview show stale
 * products long after newer nights had arrived. `attempts` and `error` come
 * back too so the preview can say a run is stuck instead of pretending it is
 * fine.
 */
export async function pendingBestbuyRun() {
  const { rows } = await pool.query(
    `SELECT id, post_date, post_at, attempts, error FROM bestbuy_runs
      WHERE posted_at IS NULL ORDER BY post_at DESC LIMIT 1`,
  );
  if (!rows.length) return null;
  const items = await pool.query(
    `SELECT sku, raw_title AS "rawTitle", price_display AS "priceDisplay", link,
            image_url AS "imageUrl", units, states, stock, regions, merch
       FROM bestbuy_items WHERE run_id = $1 ORDER BY units DESC`,
    [rows[0].id],
  );
  return { ...rows[0], items: items.rows };
}

/**
 * Reopen the most recent BestBuy digest so the ticker sends it again.
 *
 * `retryBestbuyRun` only touches runs that never posted, which leaves no way
 * back from a dry run: it marks the run posted so it is not rebuilt every
 * minute, and turning BESTBUY_LIVE on afterwards finds nothing left to send.
 * This clears the post itself. The caller is handed the row as it stood, so
 * it can warn when the digest really did reach members.
 */
export async function reopenBestbuyRun() {
  const { rows } = await pool.query(
    `SELECT id, post_date, post_at, posted_at, message_id, form
       FROM bestbuy_runs ORDER BY post_date DESC LIMIT 1`,
  );
  if (!rows.length) return null;
  await pool.query(
    `UPDATE bestbuy_runs
        SET posted_at = NULL, message_id = NULL, attempts = 0, error = NULL
      WHERE id = $1`,
    [rows[0].id],
  );
  return rows[0];
}

/**
 * The last few BestBuy runs with everything the ticker filters on.
 *
 * `claimDueBestbuyRun` takes the oldest run where posted_at is null, post_at
 * has passed and attempts is under five. When a morning goes quiet with no
 * alert at all, one of those three is the reason and this is the only way to
 * see which.
 */
export async function recentBestbuyRuns(limit = 5) {
  const { rows } = await pool.query(
    `SELECT r.id, r.post_date, r.post_at, r.posted_at, r.attempts, r.error, r.form,
            r.message_id,
            (SELECT count(*)::int FROM bestbuy_items i WHERE i.run_id = r.id) AS items
       FROM bestbuy_runs r
      ORDER BY r.post_date DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** The most recent fired draw run and the items it held. For `!drawrefresh`. */
export async function latestDrawRun() {
  const { rows } = await pool.query(
    // draw_date is cast to text on the way out. A DATE column arrives as a JS
    // Date, and every item carries its draw date as the string "2026-11-12",
    // so comparing the two silently matched nothing: !drawrepair reported
    // finding no items for a draw whose embeds were sitting right there.
    `SELECT id, to_char(draw_date, 'YYYY-MM-DD') AS draw_date, starts_at, ends_at, image_url
       FROM draw_runs WHERE fired_at IS NOT NULL
      ORDER BY fired_at DESC LIMIT 1`,
  );
  if (!rows.length) return null;
  const items = await pool.query(
    `SELECT pid, raw_title AS "rawTitle", product_name AS "productName",
            price_display AS "priceDisplay", price_cents AS "priceCents",
            image_url AS "imageUrl", classification
       FROM draw_items WHERE run_id = $1 AND withdrawn = FALSE ORDER BY id`,
    [rows[0].id],
  );
  return { ...rows[0], items: items.rows };
}

/**
 * Rewrite a scheduled member post that has not gone out yet.
 *
 * Only touches rows with no posted_at, so a copy change can be applied to the
 * rest of a day's posts without disturbing the ones already sent. The due time
 * is deliberately left alone: this changes wording, not the schedule.
 */
export async function updatePendingDiscordPost({ runId, slot, body, imageUrl }) {
  const { rows } = await pool.query(
    `UPDATE discord_posts SET body = $3, image_url = $4
      WHERE run_id = $1 AND slot = $2 AND posted_at IS NULL
      RETURNING slot, due_at`,
    [runId, slot, body, imageUrl],
  );
  return rows[0] ?? null;
}

/**
 * Record when a Target draw closes.
 *
 * Overwrites rather than erroring on a repeat: HK may click the bookmarklet
 * twice, or Target may extend a window, and the newest reading is the one to
 * trust.
 */
export async function setTargetCloseTime({ tcin, closesAt, raw = null, source = 'bookmarklet' }) {
  const { rows } = await pool.query(
    `INSERT INTO target_close_times (tcin, closes_at, source, raw, updated_at)
          VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tcin) DO UPDATE
            SET closes_at = EXCLUDED.closes_at,
                source    = EXCLUDED.source,
                raw       = EXCLUDED.raw,
                updated_at = now()
       RETURNING tcin, closes_at, updated_at`,
    [String(tcin), closesAt, source, raw],
  );
  return rows[0];
}

/** The close time for one listing, or null when nobody has sent it yet. */
export async function targetCloseTime(tcin) {
  const { rows } = await pool.query(
    'SELECT tcin, closes_at, source, updated_at FROM target_close_times WHERE tcin = $1',
    [String(tcin)],
  );
  return rows[0] ?? null;
}

/**
 * The close time to use for a whole draw.
 *
 * A draw is several listings and HK will not click every one of them. Any
 * listing's time stands for the draw, and the latest is taken so that a window
 * Target extended on one item does not get undercut by a stale reading on
 * another.
 */
export async function targetCloseTimeFor(tcins) {
  if (!tcins?.length) return null;
  const { rows } = await pool.query(
    `SELECT tcin, closes_at FROM target_close_times
       WHERE tcin = ANY($1) ORDER BY closes_at DESC LIMIT 1`,
    [tcins.map(String)],
  );
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------- Target */

/**
 * The run a newly seen Target listing belongs to.
 *
 * Target draws overlap and run for days, and new listings appear throughout.
 * Any listing seen while a run is open joins it rather than starting a second
 * one, which is what makes "Target added an item mid draw" work.
 *
 * Deliberately not enforced by a unique index. A constraint here would turn a
 * surprise, two genuinely separate draws open at once, into failed inserts and
 * lost items. Picking the newest open run degrades instead.
 */
export async function openTargetRun() {
  const { rows } = await pool.query(
    `SELECT id, status, opened_at, closes_at, headline, image_url, announced_at
       FROM target_runs WHERE completed_at IS NULL
      ORDER BY opened_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function startTargetRun({ closesAt = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO target_runs (closes_at) VALUES ($1)
       RETURNING id, status, opened_at, closes_at`,
    [closesAt],
  );
  return rows[0];
}

/**
 * Add listings to a run, returning only the ones that were not already there.
 *
 * The caller needs that distinction: items added mid draw are worth saying out
 * loud in the next reminder, and re-announcing the whole list every time an
 * embed arrives would be noise.
 *
 * A listing Target pulled and then restored comes back by clearing removed_at,
 * rather than being counted as new.
 */
export async function addTargetItems(runId, items) {
  const added = [];
  for (const i of items) {
    const { rows } = await pool.query(
      `INSERT INTO target_items
         (run_id, tcin, raw_title, product_name, set_name, link, affiliate, image_url, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id, tcin) DO UPDATE
          SET link = EXCLUDED.link,
              affiliate = EXCLUDED.affiliate,
              product_name = COALESCE(EXCLUDED.product_name, target_items.product_name),
              set_name = COALESCE(EXCLUDED.set_name, target_items.set_name),
              removed_at = NULL
       RETURNING tcin, (xmax = 0) AS inserted`,
      [runId, String(i.tcin), i.rawTitle, i.productName ?? null, i.set ?? null,
       i.link, Boolean(i.affiliate), i.image ?? null, i.classification ?? 'pokemon'],
    );
    if (rows[0]?.inserted) added.push(rows[0].tcin);
  }
  return added;
}

/** Mark listings Target has pulled. Returns the ones that changed state. */
export async function markTargetItemsRemoved(runId, tcins) {
  if (!tcins?.length) return [];
  const { rows } = await pool.query(
    `UPDATE target_items SET removed_at = now()
      WHERE run_id = $1 AND tcin = ANY($2) AND removed_at IS NULL
      RETURNING tcin`,
    [runId, tcins.map(String)],
  );
  return rows.map((r) => r.tcin);
}

/** A run's listings. Removed ones are left out unless asked for. */
export async function targetRunItems(runId, { includeRemoved = false } = {}) {
  const { rows } = await pool.query(
    `SELECT tcin, raw_title, product_name, set_name, link, affiliate,
            image_url, classification, seen_at, removed_at
       FROM target_items
      WHERE run_id = $1 ${includeRemoved ? '' : 'AND removed_at IS NULL'}
      ORDER BY seen_at`,
    [runId],
  );
  return rows;
}

export async function setTargetRunCloseTime(runId, closesAt) {
  const { rows } = await pool.query(
    'UPDATE target_runs SET closes_at = $2 WHERE id = $1 RETURNING id, closes_at',
    [runId, closesAt],
  );
  return rows[0] ?? null;
}

export async function markTargetRunAnnounced(runId, { headline, imageUrl }) {
  await pool.query(
    `UPDATE target_runs
        SET status = 'live', announced_at = now(), headline = $2, image_url = $3
      WHERE id = $1`,
    [runId, headline ?? null, imageUrl ?? null],
  );
}

export async function completeTargetRun(runId, error = null) {
  await pool.query(
    `UPDATE target_runs SET completed_at = now(), status = 'done', error = $2 WHERE id = $1`,
    [runId, error],
  );
}

export async function recordTargetPost({ runId, slot, channelId, bufferPostId }) {
  await pool.query(
    `INSERT INTO target_posts (run_id, slot, channel_id, buffer_post_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (run_id, slot, channel_id) DO NOTHING`,
    [runId, slot, String(channelId), String(bufferPostId)],
  );
}

/** Every run still open, oldest first, for the reminder ticker. */
export async function openTargetRuns() {
  const { rows } = await pool.query(
    `SELECT id, status, opened_at, closes_at, headline, image_url, announced_at
       FROM target_runs WHERE completed_at IS NULL ORDER BY opened_at`,
  );
  return rows;
}

/** Which slots a run has already posted, so a ticker never doubles up. */
export async function targetRunSlots(runId) {
  const { rows } = await pool.query(
    'SELECT DISTINCT slot FROM target_posts WHERE run_id = $1', [runId],
  );
  return new Set(rows.map((r) => r.slot));
}

/** Queue a Reddit post. One row per sub, since each is its own submission. */
export async function scheduleRedditPost({
  source, runId = null, slot, sub, dueAt, title, body, imageUrl = null,
}) {
  await pool.query(
    `INSERT INTO reddit_posts (source, run_id, slot, sub, due_at, title, body, image_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source, run_id, slot, sub) DO UPDATE
       SET due_at = EXCLUDED.due_at, title = EXCLUDED.title,
           body = EXCLUDED.body, image_url = EXCLUDED.image_url`,
    [source, runId, slot, sub, dueAt, title, body, imageUrl],
  );
}

/**
 * Claim the Reddit posts that are due.
 *
 * Six rather than two: in manual mode a tick is Discord messages, not Reddit
 * submissions, and a draw's announcement covers both subs at once. Delivering
 * half a set and the rest a minute later would read as two separate things to
 * paste. The API path spaces its submissions out itself.
 */
export async function claimDueRedditPosts({ limit = 6 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, source, run_id, slot, sub, title, body, image_url, attempts
       FROM reddit_posts
      WHERE posted_at IS NULL AND due_at <= now() AND attempts < 4
      ORDER BY due_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function markRedditPosted(id, { fullname, permalink, approved }) {
  await pool.query(
    `UPDATE reddit_posts
        SET posted_at = now(), fullname = $2, permalink = $3, approved = $4, error = NULL
      WHERE id = $1`,
    [id, fullname, permalink, approved],
  );
}

export async function markRedditFailed(id, message) {
  await pool.query(
    'UPDATE reddit_posts SET attempts = attempts + 1, error = $2 WHERE id = $1',
    [id, String(message).slice(0, 500)],
  );
}

/** The most recent posted submission for a run, for crossposting by hand. */
export async function latestRedditPost(source = null) {
  const { rows } = await pool.query(
    `SELECT id, source, slot, sub, title, fullname, permalink, posted_at
       FROM reddit_posts
      WHERE posted_at IS NOT NULL AND fullname IS NOT NULL
        AND ($1::text IS NULL OR source = $1)
      ORDER BY posted_at DESC LIMIT 1`,
    [source],
  );
  return rows[0] ?? null;
}

/**
 * Add or update items on a run that has already fired.
 *
 * saveRun refuses to touch a run past "collecting", which is right for the
 * normal path: a fired run must not be silently rewritten by a late embed.
 * This is the deliberate repair case, where an item was wrongly excluded by a
 * classifier bug and has to be put back.
 *
 * Returns the pids that were genuinely new, so the caller can say what it
 * recovered rather than claiming to have fixed something that was never wrong.
 */
export async function addDrawItems(runId, items) {
  const added = [];
  for (const it of items) {
    const { rows } = await pool.query(
      `INSERT INTO draw_items
         (run_id, pid, raw_title, product_name, price_display, price_cents, image_url, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (run_id, pid) DO UPDATE
         SET raw_title = EXCLUDED.raw_title, product_name = EXCLUDED.product_name,
             price_display = EXCLUDED.price_display, price_cents = EXCLUDED.price_cents,
             image_url = EXCLUDED.image_url, classification = EXCLUDED.classification,
             withdrawn = FALSE
       RETURNING pid, (xmax = 0) AS inserted`,
      [runId, it.pid, it.rawTitle, it.productName, it.priceDisplay,
       it.priceCents, it.imageUrl, it.classification],
    );
    if (rows[0]?.inserted) added.push(rows[0].pid);
  }
  return added;
}

/** The Buffer posts recorded for a run, so a repair can edit them. */
export async function drawBufferPosts(runId) {
  const { rows } = await pool.query(
    `SELECT slot, channel_id AS "channelId", buffer_post_id AS "bufferPostId"
       FROM buffer_posts WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows;
}

/**
 * PIDs that appeared in an earlier queue run, with when they last did.
 *
 * Walmart's monitor pings an item when it LEAVES the queue as well as when it
 * joins, and the two embeds are identical. A drop therefore arrives mixed with
 * last week's items being cleared out: one real run of four items came through
 * as fifteen, eleven of them the previous week's.
 *
 * Nothing in an embed can tell the two apart, but the bot has already seen
 * last week's items, so its own history can. Bounded by a window because a
 * product genuinely queued again months later is a new drop, not a repeat.
 */
export async function previousQueuePids({ beforeDropDate, days = 35 }) {
  const { rows } = await pool.query(
    `SELECT qi.pid, MAX(qr.drop_date) AS last_seen
       FROM queue_items qi
       JOIN queue_runs qr ON qr.id = qi.run_id
      WHERE qr.drop_date < $1
        AND qr.drop_date >= ($1::date - ($2::int))
      GROUP BY qi.pid`,
    [beforeDropDate, days],
  );
  return new Map(rows.map((r) => [
    String(r.pid),
    typeof r.last_seen === 'string' ? r.last_seen : r.last_seen.toISOString().slice(0, 10),
  ]));
}

