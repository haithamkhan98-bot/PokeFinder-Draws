/**
 * Paste ready Reddit posts for the alert channel.
 *
 * Reddit closed self-service API access to new developers, so there is no
 * supported way for the bot to submit these itself. Rather than throw the copy
 * away, the same queue that would have posted them now delivers them to HK
 * formatted to paste: the timing, the per sub split, the item list and the
 * links are all still worked out by the bot, and the only manual part is the
 * paste.
 *
 * Everything here is deliberately reusable by the API path. If credentials
 * ever arrive, switching REDDIT_MODE back to api uses the same queued rows.
 */

/** Discord refuses a message over this, so a long body is split. */
export const DISCORD_LIMIT = 2000;

/**
 * Split a body into chunks that fit, breaking on line boundaries.
 *
 * Breaking mid line would split a markdown link across two messages and make
 * the paste useless, which is the whole point of this.
 */
export function chunk(text, limit) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let cur = '';
  for (const line of lines) {
    // A single line longer than the limit cannot be helped by line breaking,
    // so it goes out on its own and Discord truncates rather than the whole
    // batch failing.
    if (line.length >= limit) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(line);
      continue;
    }
    if (cur.length + line.length + 1 > limit) { out.push(cur); cur = line; continue; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const fence = (s) => `\`\`\`\n${s}\n\`\`\``;

/**
 * One queued row as the messages to send to the alert channel.
 *
 * The title and the body are in separate code blocks so each can be copied in
 * one gesture without picking the other up. Code blocks also stop Discord
 * rendering the markdown, which would otherwise turn the links into previews
 * and make the raw text impossible to copy back out.
 */
export function manualMessages(row, { limit = DISCORD_LIMIT } = {}) {
  const when = row.slot === 'announcement' ? 'now' : `the ${row.slot} beat`;
  const head = [
    `**Reddit post ready to paste** r/${row.sub}, ${when}`,
    row.image_url ? `Image: ${row.image_url}` : 'No image for this one.',
    '',
    '**Title**',
    fence(row.title),
    '',
    '**Body** (paste into the post body with markdown mode on)',
  ].join('\n');

  const messages = [head];
  // The fence adds 8 characters, and the room for them has to come out of the
  // chunk budget or a body that just fits would push the message over.
  for (const part of chunk(row.body, limit - 10)) messages.push(fence(part));
  return messages;
}

/**
 * Deliver one queued row to the alert channel.
 *
 * Returns the same shape the API path returns so the ticker does not care
 * which mode it is in. `approved` is true because there is nothing to approve:
 * HK posts it himself and AutoModerator does not remove his manual posts.
 */
export async function deliverManually(row, { alert }) {
  for (const message of manualMessages(row)) await alert(message);
  return {
    fullname: null,
    url: null,
    approved: true,
    manual: true,
    imageError: null,
    approveError: null,
  };
}
