import { groupQueue, orderedQueueItems } from './queue.js';
import {
  buildQueuePosts, linkList, productBlock, drawOverWithQueue, potentialQueuePost, isFirstPartySeller,
  queueSummary,
} from './queue-copy.js';
import { buildGrid } from './grid.js';
import { nameItems, queueHeadline } from './naming.js';
import { createOnDrawChannels, CHANNELS, editPost } from './buffer.js';
import { storeImage, setQueueRunResult, recordQueuePost, drawOverPostsOn } from './db.js';
import { imageUrl } from './server.js';
import { fetchAndTrim } from './image.js';

/** Queue runs go to CollectFinder alone, not PokemonFindr and not Facebook. */
export const QUEUE_CHANNELS = [CHANNELS.collectfinder];

/**
 * Everything a fired queue run produces.
 *
 * The grid is composited here rather than through Canva: a queue image is only
 * product photos on a background, with no text, so there is nothing a template
 * would add and the canvas has to scale with the item count anyway.
 */
export async function runQueue({ runId, items, dropAt, now, asDraft = true, publishAnnouncement = false }) {
  const report = { imageError: null, posts: [], naming: null, headline: null };

  // Tidy the product names first: the headline and every product line use them.
  const naming = await nameItems(items);
  const named = naming.items.map((i, idx) => ({ ...items[idx], ...i }));
  report.naming = naming;

  const ordered = orderedQueueItems(named);
  const groups = groupQueue(named);

  // The fallback is the same summary rule the late queue draft uses: Pokemon by
  // set, every other game by name, sports by line. It reads like HK's own
  // wording, which the old lead-product fallback did not.
  const head = await queueHeadline(groups, { fallback: queueSummary(named) });
  report.headline = head;

  // Photos, then the grid.
  let url = null;
  try {
    const withPhotos = [];
    for (const it of ordered) {
      if (!it.imageUrl) throw new Error(`${it.pid} has no product photo in its embed`);
      const { buffer } = await fetchAndTrim(it.imageUrl);
      withPhotos.push({ ...it, buffer });
    }
    const grid = await buildGrid(withPhotos);
    const id = await storeImage(grid.buffer, { kind: 'queue', mime: 'image/png', width: grid.width, height: grid.height });
    url = imageUrl(id);
    report.image = { url, width: grid.width, height: grid.height, bytes: grid.buffer.length, layout: grid.counts.join('+') };
  } catch (err) {
    report.imageError = err.message;
  }

  report.list = linkList(ordered);
  report.affiliate = { covered: ordered.filter((i) => i.affiliate).length, total: ordered.length };
  report.products = productBlock(ordered);

  const posts = buildQueuePosts({ items: ordered, dropAt, headline: head.headline, now });

  for (const post of posts) {
    // The announcement is the one that races; the other two are scheduled.
    const publishNow = publishAnnouncement && post.slot === 'announcement';
    if (!publishNow && post.dueAt && post.dueAt.toMillis() <= Date.now()) {
      report.posts.push({ slot: post.slot, dueAt: post.dueAt, skipped: 'its send time had already passed', results: [] });
      continue;
    }

    const results = await createOnDrawChannels({
      text: post.text,
      dueAt: post.dueAt ? post.dueAt.toUTC().toISO() : null,
      saveToDraft: asDraft && !publishNow,
      publishNow,
      imageUrl: url,
      altText: altFor(ordered, dropAt),
    }, QUEUE_CHANNELS);

    for (const r of results) {
      if (r.ok && runId) {
        await recordQueuePost({ runId, slot: post.slot, channelId: r.channelId, bufferPostId: r.postId }).catch(() => {});
      }
    }
    report.posts.push({ slot: post.slot, dueAt: post.dueAt, publishNow, results });
  }

  // Draws and queue drops both land on Wednesdays. When the same day already
  // has a draw whose closing post is waiting to go out at 6PM, rewrite it to
  // point at the 9PM queue rather than letting the two sit unconnected.
  report.handoff = await foldIntoDrawClosingPost({
    dropDate: dropAt.setZone('America/New_York').toISODate(),
    items: ordered,
    dropAt,
    dryRun: asDraft,
  });

  if (runId) {
    await setQueueRunResult(runId, { headline: head.headline, imageUrl: url }).catch(() => {});
  }
  return report;
}

const altFor = (items, dropAt) =>
  `${items.slice(0, 6).map((i) => i.postName ?? i.productName).join(', ')}`
  + ` dropping on Walmart ${dropAt.setZone('America/New_York').toFormat('LLLL d')} at 9PM EST`;

/** A short human summary of a queue run for the alert channel. */
export function summariseQueue(report) {
  return report.posts.map((p) => {
    if (p.skipped) return `  ${p.slot.padEnd(13)} skipped, ${p.skipped}`;
    const ok = p.results.filter((r) => r.ok).length;
    const when = p.publishNow ? 'PUBLISHED NOW'
      : p.dueAt ? p.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') : 'draft, no schedule';
    const errs = p.results.filter((r) => !r.ok).map((r) => r.error).join('; ');
    return `  ${p.slot.padEnd(13)} ${ok}/${p.results.length} ${when}${errs ? ` — ${errs}` : ''}`;
  }).join('\n');
}

/**
 * Rewrite the same day's draw closing post to announce the queue.
 *
 * The existing image is left alone: omitting assets from an edit preserves
 * them, and that post is still the draw's, so it keeps the draw's picture.
 */
export async function foldIntoDrawClosingPost({ dropDate, items, dropAt, dryRun = false }) {
  let posts;
  try {
    posts = await drawOverPostsOn(dropDate);
  } catch (err) {
    return { attempted: false, error: `could not look up the draw closing post: ${err.message}` };
  }
  if (!posts.length) return { attempted: false, reason: 'no draw on this date' };

  const text = drawOverWithQueue({ items, dropAt });
  // A dry run must not touch the draw's closing post: that post is already
  // scheduled and real. Report the text it would have written instead.
  if (dryRun) return { attempted: false, dryRun: true, reason: 'queue posts are drafts', text };

  const results = [];
  for (const row of posts) {
    try {
      await editPost({ postId: row.buffer_post_id, text });
      results.push({ channelId: row.channel_id, ok: true });
    } catch (err) {
      results.push({ channelId: row.channel_id, ok: false, error: err.message });
    }
  }
  return { attempted: true, results, text };
}

/**
 * The late queue: one Buffer draft, never published.
 *
 * These land ten to twenty minutes before the drop, with a predicted price and
 * sometimes a marketplace seller rather than Walmart itself, so they get a
 * draft for review rather than going straight out. The grid is built the same
 * way as the standard queue, products only.
 */
export async function runPotentialQueue({ items, dropAt }) {
  const report = { imageError: null, results: [], items: items.length };

  const naming = await nameItems(items);
  const named = naming.items.map((i, idx) => ({ ...items[idx], ...i }));
  report.naming = naming;

  const ordered = orderedQueueItems(named);

  let url = null;
  try {
    const withPhotos = [];
    for (const it of ordered) {
      if (!it.imageUrl) throw new Error(`${it.pid} has no product photo in its embed`);
      const { buffer } = await fetchAndTrim(it.imageUrl);
      withPhotos.push({ ...it, buffer });
    }
    const grid = await buildGrid(withPhotos);
    const id = await storeImage(grid.buffer, { kind: 'queue', mime: 'image/png', width: grid.width, height: grid.height });
    url = imageUrl(id);
    report.image = { url, width: grid.width, height: grid.height, bytes: grid.buffer.length, layout: grid.counts.join('+') };
  } catch (err) {
    report.imageError = err.message;
  }

  report.text = potentialQueuePost({ items: ordered, dropAt });

  report.results = await createOnDrawChannels({
    text: report.text,
    dueAt: null,
    saveToDraft: true,          // never published, whatever BUFFER_LIVE says
    imageUrl: url,
    altText: altFor(ordered, dropAt),
  }, QUEUE_CHANNELS);

  // Sellers other than Walmart are worth surfacing: these embeds carry a
  // predicted seller and it is not always Walmart itself.
  report.affiliate = {
    covered: ordered.filter((i) => i.affiliate).length,
    total: ordered.length,
  };

  report.thirdParty = ordered
    .filter((i) => !isFirstPartySeller(i.seller))
    .map((i) => `${i.productName} (${i.seller})`);

  return report;
}
