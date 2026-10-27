import { claimDueDiscordPosts, markDiscordPosted, markDiscordFailed } from './db.js';

/**
 * Sends the member facing Discord posts when they fall due.
 *
 * The schedule lives in Postgres rather than in timers, so a redeploy or a
 * crash cannot lose a post. This only has to notice that something is due,
 * which a short poll does perfectly well and far more simply than anything
 * clever.
 */
export function startDiscordScheduler(client, { intervalMs = 30_000, onError } = {}) {
  let running = false;

  const tick = async () => {
    if (running || !client.isReady()) return;
    running = true;
    try {
      const due = await claimDueDiscordPosts();
      for (const post of due) {
        try {
          const channel = await client.channels.fetch(post.channel_id);
          if (!channel?.isTextBased?.()) throw new Error('channel is not a text channel the bot can post in');

          const sent = await channel.send({
            content: post.body.slice(0, 1990),
            // Without this the role mention renders but does not ping.
            allowedMentions: { parse: ['roles'] },
          });
          await markDiscordPosted(post.id, sent.id);
          console.log(`posted discord ${post.slot} for run ${post.run_id}`);
        } catch (err) {
          await markDiscordFailed(post.id, err.message);
          // Five attempts, then it stops retrying and stays visible in the table.
          onError?.(
            `Discord post "${post.slot}" for run ${post.run_id} failed `
            + `(attempt ${post.attempts + 1} of 5): ${err.message}`,
          );
        }
      }
    } catch (err) {
      console.error('discord scheduler tick failed:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
