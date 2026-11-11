import { claimDueDiscordPosts, markDiscordPosted, markDiscordFailed } from './db.js';

/**
 * Sends the member facing Discord posts when they fall due.
 *
 * Serves both queues, Walmart draws and Target raffles. Each claimed row says
 * which one it came from, so one scheduler and one retry policy cover both
 * rather than a second poll loop drifting out of step with this one.
 *
 * The schedule lives in Postgres rather than in timers, so a redeploy or a
 * crash cannot lose a post. This only has to notice that something is due,
 * which a short poll does perfectly well and far more simply than anything
 * clever.
 *
 * The poll interval is the worst case lateness: a post due at 5:00:00 goes out
 * between 5:00:00 and 5:00:10. Ten seconds costs one indexed query every ten
 * seconds and buys a go live post that reads as on the hour.
 */
export function startDiscordScheduler(client, { intervalMs = 10_000, onError } = {}) {
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

          const body = {
            content: post.body.slice(0, 1990),
            // Without this the role mention renders but does not ping.
            allowedMentions: { parse: ['roles'] },
          };

          let sent;
          let lostImage = null;
          try {
            sent = await channel.send({
              ...body,
              // The draw graphic, the same one the tweets carry. Discord
              // fetches it from the Railway image host, which does not expire
              // the way a Canva export link does.
              ...(post.image_url ? { files: [post.image_url] } : {}),
            });
          } catch (err) {
            // A send with an attachment needs Attach Files on top of Send
            // Messages, and Discord reports the lack of it as the same
            // "Missing Permissions" as not being able to post at all. A draw
            // announcement was lost to this while text-only reminders in the
            // same channel had always worked.
            //
            // A post without its picture beats no post, so the attachment is
            // dropped and the text goes out. The alert says what was lost.
            if (!post.image_url) throw err;
            lostImage = err.message;
            sent = await channel.send(body);
          }

          await markDiscordPosted(post.id, sent.id, post.source);
          console.log(`posted discord ${post.source} ${post.slot} for run ${post.run_id}`
            + (lostImage ? ' WITHOUT its image' : ''));
          if (lostImage) {
            onError?.(
              `Discord post "${post.slot}" for ${post.source} run ${post.run_id} went out `
              + `WITHOUT the grid image: ${lostImage}\n`
              + 'This is usually the Attach Files permission missing in that channel.',
            );
          }
        } catch (err) {
          await markDiscordFailed(post.id, err.message, post.source);
          // Five attempts, then it stops retrying and stays visible in the table.
          onError?.(
            `Discord post "${post.slot}" for ${post.source} run ${post.run_id} failed `
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
