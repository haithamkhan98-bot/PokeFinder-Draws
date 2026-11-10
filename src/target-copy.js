import { orderedItems, orderedSets, joinEnglish, timeLabel } from './copy.js';

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

/**
 * The deadline, as a clause for the opening line rather than a block of its
 * own.
 *
 * This is the whole reason the close time is collected by hand. A Target draw
 * runs for days, so unlike a Walmart draw the thing a reader needs is not when
 * it starts but when it stops, and it belongs in the first line where someone
 * scrolling past will see it.
 *
 * The date is stated as well as the clock. A draw that opens Monday and closes
 * Wednesday makes a bare time ambiguous.
 */
export function deadlineClause(closesAt) {
  if (!closesAt) return null;
  const et = closesAt.setZone('America/New_York');
  return `Entries Accepted by ${et.toFormat('LLLL d')} at ${timeLabel(closesAt)}!`;
}

/** Inside the final hour the date is noise: the reader is deciding right now. */
export function closingClause(closesAt) {
  return closesAt ? `Entries Close at ${timeLabel(closesAt)}!` : null;
}

/** One line per item: name then its own entry link. */
export function raffleItemLines(items) {
  return orderedItems(items)
    .map((i) => `${i.postName ?? i.productName ?? i.rawTitle} ${i.link}`)
    .join('\n');
}

const body = (...blocks) => blocks.filter(Boolean).join('\n\n');

/**
 * 9AM the morning after a draw opens, or null when that is not a sensible
 * moment to say anything.
 *
 * Skipped when it lands after the close, or inside the final hour, since the
 * closing post already covers that stretch and two posts minutes apart read
 * as one message sent twice.
 *
 * Exported so the ticker and the copy agree on when it is. Two separate
 * calculations would drift, and the symptom would be a reminder that is never
 * built or one built twice.
 */
export function morningReminderAt(openedAt, closesAt) {
  if (!closesAt) return null;
  const morning = openedAt.setZone('America/New_York').plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  return morning < closesAt.minus({ hours: 1 }) ? morning : null;
}

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
    text: body(
      [`💫 Target ${headline} Draws Are Live Now!`, deadlineClause(closesAt)].filter(Boolean).join(' '),
      list, BOOKMARK, TAGS,
    ),
  });

  if (!closesAt) return posts;

  const morning = morningReminderAt(now, closesAt);
  if (morning) {
    posts.push({
      slot: 'morning',
      dueAt: morning,
      discord: false,
      text: body(
        `💫 Reminder: The Target ${headline} Draws Are Still Open! ${deadlineClause(closesAt)}`,
        list, BOOKMARK, TAGS,
      ),
    });
  }

  posts.push({
    slot: 'closing',
    dueAt: closesAt.minus({ hours: 1 }),
    discord: true,
    text: body(
      `💫 1 Hour Left to Enter the Target ${headline} Draws! ${closingClause(closesAt)}`,
      list, TAGS,
    ),
  });

  return posts;
}

/**
 * The two member facing Discord posts for a Target raffle.
 *
 * Live and closing only, matching the `discord` flags on the beats above. The
 * morning reminder is deliberately not one: members already got the
 * announcement and will get the hour warning, and a third ping on a draw they
 * have had a day to enter is what makes people mute a role.
 *
 * Close times are Discord timestamps rather than written-out clock times.
 * They render in each member's own timezone and count themselves down, so a
 * post written on Monday still reads correctly on Wednesday. Walmart's member
 * posts work the same way.
 *
 * Every item carries its own markdown link, because Target has no catchall
 * draw page: there is no single "Draw Link" footer to put at the bottom the
 * way the Walmart posts have.
 *
 * `role` must be the mention string `<@&id>`. Discord renders the literal text
 * "@PokeFinder+" without pinging anyone.
 */
export function targetDiscordPosts({ items, now, closesAt, role = '@PokeFinder+' }) {
  if (!closesAt) return [];
  const headline = raffleHeadline(items);
  const ordered = orderedItems(items);
  const noun = ordered.length > 1 ? 'Draws' : 'Draw';
  const lines = ordered
    .map((i) => `- [${i.postName ?? i.productName ?? i.rawTitle}](${i.link})`)
    .join('\n');
  const close = Math.floor(closesAt.toSeconds());

  return [
    {
      slot: 'live',
      dueAt: now,
      text: [
        `# Target ${headline} ${noun} Are Live Now`,
        '',
        `**Entries accepted until <t:${close}:F> (<t:${close}:R>)** ${role}`,
        '',
        `**Items in These ${noun}:**`,
        lines,
      ].join('\n'),
    },
    {
      slot: 'closing',
      dueAt: closesAt.minus({ hours: 1 }),
      text: [
        `# 1 Hour Left to Enter the Target ${headline} ${noun}`,
        '',
        `**Entries close <t:${close}:R>** ${role}`,
        '',
        `**Items in These ${noun}:**`,
        lines,
      ].join('\n'),
    },
  ];
}
