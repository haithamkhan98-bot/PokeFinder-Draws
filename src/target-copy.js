import { orderedItems, orderedSets, joinEnglish } from './copy.js';

/**
 * Copy for Target raffles.
 *
 * Shaped differently from Walmart on purpose. A Walmart draw is announced
 * ahead of a known window, so its posts count down to a start. A Target draw
 * is already open when the monitor sees it, so the first post is "this is
 * live", and the later ones are "still open" and "nearly over".
 *
 * Every item also carries its own link, because Target has no catchall draw
 * page the way Walmart does: each listing is its own entry.
 */

const BOOKMARK = "Bookmark & Follow! We'll post every Target draw as soon as it goes live!";
const TAGS = '#Pokemon #ad';

/** Sets present, 30th Celebration first, as a readable phrase. */
export function raffleHeadline(items) {
  const sets = [...new Set(items.map((i) => i.set).filter(Boolean))];
  return sets.length ? joinEnglish(orderedSets(sets)) : 'Pokemon';
}

/** One line per item: name then its own entry link. */
export function raffleItemLines(items) {
  return orderedItems(items)
    .map((i) => `${i.postName ?? i.productName ?? i.rawTitle} ${i.link}`)
    .join('\n');
}

const body = (...blocks) => blocks.filter(Boolean).join('\n\n');

/**
 * The three beats.
 *
 * `closesAt` is optional and comes from HK by command, because Target only
 * shows the window to a signed in account. Without it the announcement still
 * goes out; the two reminders are simply not scheduled, which is the right
 * failure: being late to announce costs more than missing a reminder.
 *
 * The morning reminder is skipped when 9AM lands after the close, or inside
 * the final hour, since the closing post already covers that stretch.
 */
export function buildRafflePosts({ items, now, closesAt = null }) {
  const headline = raffleHeadline(items);
  const list = raffleItemLines(items);
  const posts = [];

  posts.push({
    slot: 'live',
    dueAt: null,
    discord: true,
    text: body(`💫 Target ${headline} Draws Are Live Now!`, list, BOOKMARK, TAGS),
  });

  if (!closesAt) return posts;

  const morning = now.setZone('America/New_York').plus({ days: 1 }).set({
    hour: 9, minute: 0, second: 0, millisecond: 0,
  });
  if (morning < closesAt.minus({ hours: 1 })) {
    posts.push({
      slot: 'morning',
      dueAt: morning,
      discord: false,
      text: body(`💫 Reminder: The Target ${headline} Draws Are Still Open!`, list, BOOKMARK, TAGS),
    });
  }

  posts.push({
    slot: 'closing',
    dueAt: closesAt.minus({ hours: 1 }),
    discord: true,
    text: body(`💫 1 Hour Left to Enter the Target ${headline} Draws!`, list, TAGS),
  });

  return posts;
}
