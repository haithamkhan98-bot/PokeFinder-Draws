import { claimDueBestbuyRun, markBestbuyPosted, markBestbuyFailed } from './db.js';
import { bestbuyDigest } from './bestbuy-copy.js';
import { nameItems } from './naming.js';

/** Matches the attempts filter in claimDueBestbuyRun. */
export const MAX_ATTEMPTS = 5;

/**
 * Sends the BestBuy digest when its 7AM slot comes round.
 *
 * Modelled on the member draw scheduler and kept separate from it so the draw
 * path is untouched. The schedule lives in Postgres rather than in timers, so
 * a redeploy between 1AM and 7AM cannot lose the morning's digest.
 *
 * The body is built here rather than when the embeds arrived, so everything
 * collected overnight is in the post, whether it landed before midnight or
 * at 3AM.
 */
export function startBestbuyScheduler(client, {
  intervalMs = 60_000, channelId, role, checkerChannel, live = false, onError, onPosted,
} = {}) {
  if (!channelId) return () => {};
  let running = false;

  const tick = async () => {
    if (running || !client.isReady()) return;
    running = true;
    let claimed = null;
    try {
      const run = await claimDueBestbuyRun();
      if (!run) return;
      claimed = run;

      // Named here rather than inside the digest so the BestBuy post groups
      // sets the way the draws do. nameItems falls back to local naming on
      // its own, so a naming outage costs ordering, never the post.
      const naming = await nameItems(run.items.map((i, idx) => ({ ...i, pid: i.sku ?? String(idx) })));
      const digest = bestbuyDigest({ items: naming.items, role, checkerChannel });
      if (!digest) {
        // Nothing postable, usually a night of merchandise only. Close the run
        // so it is not retried every minute for the rest of the day.
        await markBestbuyPosted(run.id, { messageId: null, body: null, form: 'nothing to post' });
        onPosted?.({ run, digest: null, skipped: 'no postable products' });
        return;
      }

      if (!live) {
        await markBestbuyPosted(run.id, { messageId: null, body: digest.text, form: `${digest.form} (dry run)` });
        onPosted?.({ run, digest, dryRun: true });
        return;
      }

      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) throw new Error('instore alerts channel is not a text channel the bot can post in');

      const sent = await channel.send({
        content: digest.text.slice(0, 1990),
        // Without this the role mention renders but does not ping.
        allowedMentions: { parse: ['roles'] },
      });
      await markBestbuyPosted(run.id, { messageId: sent.id, body: digest.text, form: digest.form });
      onPosted?.({ run, digest, messageId: sent.id });
    } catch (err) {
      let attempts = null;
      try {
        if (claimed) attempts = await markBestbuyFailed(claimed.id, err.message);
      } catch { /* the failure is already being reported */ }
      // The ticker stops retrying at 5. Say so, or the run goes quiet and the
      // only symptom is a morning with no post.
      const gaveUp = attempts !== null && attempts >= MAX_ATTEMPTS;
      onError?.(
        `BestBuy digest failed: ${err.message}`
        + (attempts !== null ? ` (attempt ${attempts} of ${MAX_ATTEMPTS})` : '')
        + (gaveUp && claimed
          ? `\n\nGiving up on the ${claimed.post_date} digest. Fix the cause and run `
            + '`!bbretry` to put it back in the queue.'
          : ''),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
