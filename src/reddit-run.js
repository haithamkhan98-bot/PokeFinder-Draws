import {
  scheduleRedditPost, claimDueRedditPosts, markRedditPosted, markRedditFailed,
} from './db.js';
import { uploadImage, submit, approve, isConnected } from './reddit.js';
import { deliverManually } from './reddit-manual.js';

/**
 * Queue a set of Reddit posts from reddit-copy.js.
 *
 * One row per sub, because each sub is a separate submission with its own id
 * and its own approval. A post with `dueAt` null is due now, which is how the
 * announcement goes out the moment a draw is detected.
 */
export async function queueRedditSet({ source, runId, posts }) {
  const queued = [];
  for (const post of posts) {
    for (const sub of post.subs) {
      await scheduleRedditPost({
        source, runId, slot: post.slot, sub,
        dueAt: post.dueAt ? post.dueAt.toJSDate() : new Date(),
        title: post.title, body: post.body, imageUrl: post.imageUrl ?? null,
      });
      queued.push({ slot: post.slot, sub, dueAt: post.dueAt });
    }
  }
  return queued;
}

/**
 * Submit one claimed row: upload the grid, post, then approve at once.
 *
 * The approve is the reason this is one function rather than a post step and
 * an approve step. HK's own posts to his own subs are removed by AutoModerator
 * on submit, and the gap between posting and approving is exactly how long the
 * post is invisible. Anything that could put those two in separate ticks would
 * reintroduce the problem the modposts scope exists to solve.
 *
 * A failed approve does NOT fail the post. The submission is already up and
 * recording it is what lets a retry approve it rather than post it twice.
 */
export async function postOne(row, { deps = {} } = {}) {
  const { upload = uploadImage, send = submit, ok = approve } = deps;

  let imageAssetId = null;
  let imageError = null;
  if (row.image_url) {
    try {
      imageAssetId = await upload(row.image_url);
    } catch (err) {
      // The links and the item list are the point; the grid is decoration.
      // Losing the image is worth a post that still goes out on time.
      imageError = err.message;
    }
  }

  const posted = await send({
    sub: row.sub, title: row.title, markdown: row.body, imageAssetId,
  });

  let approved = false;
  let approveError = null;
  try {
    await ok(posted.fullname);
    approved = true;
  } catch (err) {
    approveError = err.message;
  }

  return { ...posted, approved, imageError, approveError, imageAssetId };
}

/**
 * One pass of the Reddit ticker.
 *
 * Returns what it did; the caller decides what is worth saying. A pass that
 * finds nothing due is the normal case and is silent.
 */
export async function tickReddit({
  claim = claimDueRedditPosts, post = postOne,
  markPosted = markRedditPosted, markFailed = markRedditFailed,
  connected = isConnected, alert = null, pauseMs = 2000,
  // 'manual' drops each post in the alert channel formatted to paste;
  // 'api' submits it. Manual is the default because Reddit closed
  // self-service API access, so the API path has no credentials to use.
  mode = 'manual',
} = {}) {
  const rows = await claim();
  if (!rows.length) return [];

  const manual = mode !== 'api';
  if (manual && !alert) {
    // Nowhere to deliver to. Left queued rather than failed, since this is a
    // misconfiguration and burning attempts on it would lose the posts.
    return [{ skipped: 'no alert channel to deliver paste ready posts to', due: rows.length }];
  }
  if (!manual && !await connected()) {
    // Left queued rather than failed: once the OAuth flow is done these are
    // still waiting, and a reminder whose time has passed is dropped by the
    // due check rather than posted late.
    return [{ skipped: 'Reddit is not connected yet', due: rows.length }];
  }

  // In manual mode, rows that would paste identically are delivered once with
  // every sub named. The API path keeps them separate, because each sub is its
  // own submission with its own id and approval.
  const jobs = manual ? groupIdentical(rows) : rows;

  const done = [];
  for (const [i, row] of jobs.entries()) {
    // Spaced out, because consecutive submissions from one account inside a
    // second is what Reddit's spam heuristics look for.
    // Only the API path needs spacing out; Reddit's rate limits are about
    // submissions, and a manual delivery is a Discord message.
    if (i > 0 && pauseMs && !manual) await new Promise((r) => setTimeout(r, pauseMs));
    try {
      const r = manual ? await deliverManually(row, { alert }) : await post(row);
      // Every row the job covers is marked, not just the first, or the others
      // would be redelivered on the next tick.
      for (const id of row.ids ?? [row.id]) {
        await markPosted(id, { fullname: r.fullname, permalink: r.url, approved: r.approved });
      }
      done.push({ ...r, sub: row.sub, subs: row.subs, slot: row.slot, source: row.source });

      if (alert && !r.manual && (r.imageError || r.approveError)) {
        await alert(
          `Reddit ${row.slot} to r/${row.sub} posted: ${r.url}\n`
          + (r.imageError ? `The grid image did not upload: ${r.imageError}\n` : '')
          + (r.approveError
            ? `NOT APPROVED: ${r.approveError}\nAutoModerator may have removed it, so approve it by hand.`
            : ''),
        );
      }
    } catch (err) {
      for (const id of row.ids ?? [row.id]) await markFailed(id, err.message);
      done.push({ sub: row.sub, slot: row.slot, error: err.message });
      if (alert) {
        await alert(`Reddit ${row.slot} to r/${row.sub} failed `
          + `(attempt ${row.attempts + 1} of 4): ${err.message}`);
      }
    }
  }
  return done;
}

/** A short block for the alert channel. */
export function summariseReddit(queued) {
  if (!queued.length) return 'no Reddit posts queued';
  return queued.map((q) => `  r/${q.sub.padEnd(16)} ${q.slot.padEnd(13)} `
    + `${q.dueAt ? q.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') : 'immediately'}`).join('\n');
}

/**
 * Collapse rows that would paste identically into one job.
 *
 * Keyed on the text rather than on the slot, so posts that genuinely differ
 * between subs stay separate without anything here needing to know why they
 * differ.
 */
export function groupIdentical(rows) {
  const byContent = new Map();
  for (const row of rows) {
    const key = `${row.source}|${row.run_id}|${row.slot}|${row.title}|${row.body}|${row.image_url ?? ''}`;
    if (!byContent.has(key)) byContent.set(key, { ...row, subs: [], ids: [] });
    const job = byContent.get(key);
    job.subs.push(row.sub);
    job.ids.push(row.id);
  }
  return [...byContent.values()];
}
