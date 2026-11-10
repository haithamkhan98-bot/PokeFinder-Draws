import { DateTime } from 'luxon';
import { nameItems } from './naming.js';
import { orderedItems } from './copy.js';
import { buildRafflePosts, raffleHeadline, raffleItemLines } from './target-copy.js';
import { createPost, DRAW_CHANNELS } from './buffer.js';
import { recordTargetPost, markTargetRunAnnounced, targetRunItems, storeImage } from './db.js';
import { buildGrid } from './grid.js';
import { fetchAndTrim } from './image.js';
import { imageUrl as storedImageUrl } from './server.js';

/**
 * The product grid for a Target raffle post.
 *
 * Composited locally through the same path the queue uses rather than through
 * Canva: the picture is product photos on a background with no text, so a
 * template adds nothing and the canvas has to scale with the item count.
 *
 * Rebuilt rather than reused whenever membership changes. A grid still showing
 * a product Target has pulled is worse than no grid, because the picture is
 * what most people read before the text.
 */
export async function buildTargetGrid(items) {
  const withPhotos = [];
  for (const it of items) {
    const src = it.image ?? it.imageUrl ?? null;
    if (!src) throw new Error(`${it.tcin ?? it.pid} has no product photo`);
    const { buffer } = await fetchAndTrim(src);
    withPhotos.push({ ...it, buffer });
  }
  const grid = await buildGrid(withPhotos);
  const id = await storeImage(grid.buffer, {
    kind: 'target', mime: 'image/png', width: grid.width, height: grid.height,
  });
  return {
    url: storedImageUrl(id), width: grid.width, height: grid.height,
    bytes: grid.buffer.length, layout: grid.counts.join('+'),
  };
}

/**
 * Turn an open Target run into posts.
 *
 * Reads the run's current membership from the database rather than taking the
 * items that triggered it. That is the whole point of the Target shape: by the
 * time a reminder fires, Target may have added or pulled listings, and the post
 * has to say what is enterable now rather than what was enterable on Monday.
 */
export async function runTargetRaffle({
  runId, now = DateTime.now(), closesAt = null,
  imageUrl = null, asDraft = true, publishLive = false,
  slots = null, prenamed = null,
}) {
  const rows = await targetRunItems(runId);
  const items = rows.map((r) => ({
    pid: r.tcin, tcin: r.tcin, rawTitle: r.raw_title,
    productName: r.product_name ?? r.raw_title, postName: r.product_name ?? r.raw_title,
    set: r.set_name ?? null, link: r.link, affiliate: r.affiliate,
    image: r.image_url, classification: r.classification, priceDisplay: null,
  }));

  const report = {
    runId, items: items.length, headline: null, posts: [], errors: [],
    affiliate: { total: items.length, covered: items.filter((i) => i.affiliate).length },
  };
  if (!items.length) {
    report.errors.push('the run has no live items');
    return report;
  }

  const naming = prenamed ?? await nameItems(items);
  const named = orderedItems(
    naming.items.map((i, idx) => ({ ...items[idx], ...i, link: items[idx].link })),
  );
  report.headline = raffleHeadline(named);
  report.list = raffleItemLines(named);

  // A missing grid is not a reason to skip the post. The text carries every
  // link and the close time, so a picture that failed costs reach, not the
  // announcement itself.
  let picture = imageUrl;
  if (!picture) {
    try {
      report.image = await buildTargetGrid(named);
      picture = report.image.url;
    } catch (err) {
      report.imageError = err.message;
    }
  }

  const wanted = buildRafflePosts({ items: named, now, closesAt })
    .filter((p) => !slots || slots.has(p.slot));

  // Slot by slot rather than channel by channel, so the announcement lands on
  // both accounts before any reminder is created on either.
  for (const post of wanted) {
    for (const channelId of DRAW_CHANNELS) {
      try {
        // The live announcement publishes; the reminders are scheduled. Both
        // stay drafts until TARGET_LIVE, so the first real draw can be read
        // in Buffer before anything reaches an audience.
        const created = await createPost({
          channelId,
          text: post.text,
          imageUrl: picture ?? undefined,
          altText: picture ? `${report.headline} Target draws` : undefined,
          dueAt: post.dueAt ? post.dueAt.toISO() : undefined,
          publishNow: publishLive && post.slot === 'live',
          saveToDraft: asDraft,
        });
        await recordTargetPost({ runId, slot: post.slot, channelId, bufferPostId: created.id });
        report.posts.push({
          slot: post.slot, channelId, id: created.id,
          when: post.dueAt ? post.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') : 'immediately',
          discord: post.discord,
        });
      } catch (err) {
        report.errors.push(`${post.slot} on ${channelId}: ${err.message}`);
      }
    }
  }

  if (wanted.some((p) => p.slot === 'live')) {
    await markTargetRunAnnounced(runId, { headline: report.headline, imageUrl: picture });
  }
  return report;
}

/** The run report as a block for the alert channel. */
export function summariseTarget(report) {
  if (!report.posts.length) return `no posts created. ${report.errors.join('; ') || 'unknown reason'}`;
  const bySlot = new Map();
  for (const p of report.posts) {
    if (!bySlot.has(p.slot)) bySlot.set(p.slot, { when: p.when, n: 0, discord: p.discord });
    bySlot.get(p.slot).n += 1;
  }
  const lines = [...bySlot.entries()].map(
    ([slot, v]) => `  ${slot.padEnd(10)} ${v.when.padEnd(22)} ${v.n} channel(s)${v.discord ? ' + Discord' : ''}`,
  );
  if (report.image) lines.push(`  grid       ${report.image.layout}, ${report.image.width}x${report.image.height}`);
  if (report.imageError) lines.push(`  grid       not built. ${report.imageError}`);
  if (report.errors.length) lines.push(`  errors: ${report.errors.join('; ')}`);
  return lines.join('\n');
}
