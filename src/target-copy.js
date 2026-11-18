import { orderedItems, orderedSets, joinEnglish, timeLabel } from './copy.js';

const ET = 'America/New_York';

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
export function setHeadline(items) {
  const sets = [...new Set(items.map((i) => i.set).filter(Boolean))];
  return sets.length ? joinEnglish(orderedSets(sets)) : 'Pokemon';
}

/**
 * Past this the product names stop reading as a headline and the tweet runs
 * out of room for the list, so the set names take over.
 */
export const HEADLINE_MAX = 120;
const HEADLINE_MAX_PRODUCTS = 3;

/**
 * The products themselves, as HK writes them by hand:
 * "30th Celebration Ultra-Premium Collection Day and Night and Ditto Premium
 * Collection".
 *
 * Variants sold as separate listings ("... - Day", "... - Night") fold into
 * one product with their variants joined, and the set name is said once
 * rather than in front of every product. Null when there are too many
 * products to name, or the result would be too long to lead a tweet.
 */
export function productHeadline(items) {
  const names = orderedItems(items).map((i) => ({
    name: String(i.postName ?? i.productName ?? i.rawTitle ?? '').trim(),
    set: i.set ?? null,
  }));
  if (!names.length || names.some((n) => !n.name)) return null;

  // Two ways a variant shows up: "Ultra-Premium Collection - Day" from the
  // naming step, and "Ultra Premium Collection Day" from the sheet. The
  // second only counts as a variant when another item shares everything but
  // the last word, so "Ditto Premium Collection" is not split into
  // "Ditto Premium" and "Collection".
  const lastWordBase = (n) => n.replace(/\s+\S+$/, '');
  const split = (n) => {
    const dash = n.match(/^(.*\S)\s+-\s+(.+)$/);
    if (dash) return { base: dash[1], variant: dash[2] };
    const base = lastWordBase(n);
    const shared = base !== n && names.filter((x) => lastWordBase(x.name) === base).length > 1;
    return shared ? { base, variant: n.slice(base.length).trim() } : { base: n, variant: null };
  };

  const groups = [];
  for (const { name, set } of names) {
    const { base, variant } = split(name);
    let g = groups.find((x) => x.base === base);
    if (!g) groups.push(g = { base, set, variants: [] });
    if (variant && !g.variants.includes(variant)) g.variants.push(variant);
  }
  if (!groups.length || groups.length > HEADLINE_MAX_PRODUCTS) return null;

  const said = new Set();
  const labels = groups.map((g) => {
    let label = g.base;
    if (g.set && said.has(g.set) && label.toLowerCase().startsWith(`${g.set.toLowerCase()} `)) {
      label = label.slice(g.set.length + 1);
    }
    if (g.set) said.add(g.set);
    return g.variants.length ? `${label} ${g.variants.join(' and ')}` : label;
  });
  const out = labels.join(' and ');
  return out.length > HEADLINE_MAX ? null : out;
}

/** Product names when they fit, else the sets. */
export function raffleHeadline(items) {
  return productHeadline(items) ?? setHeadline(items);
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
 * 10PM Eastern on the evening before the close, or null when that is not a
 * sensible moment to say anything.
 *
 * The evening before rather than the morning after the draw opens: the
 * morning after can be days from the close, and the reminder that moves
 * people is the one that says "tomorrow". HK picked 10PM.
 *
 * Skipped when it lands within three hours of the announcement (a reminder
 * that soon repeats the post people just saw), or within two hours of the
 * close, since the closing post covers that stretch and two posts close
 * together read as one message sent twice.
 *
 * Exported so the ticker and the copy agree on when it is. Two separate
 * calculations would drift, and the symptom would be a reminder that is never
 * built or one built twice.
 */
export const NIGHT_HOUR = 22;
export function nightReminderAt(openedAt, closesAt) {
  if (!closesAt) return null;
  const night = closesAt.setZone(ET).minus({ days: 1 })
    .set({ hour: NIGHT_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (openedAt && night < openedAt.plus({ hours: 3 })) return null;
  if (night >= closesAt.minus({ hours: 2 })) return null;
  return night;
}

/**
 * The three beats.
 *
 * `closesAt` is optional and comes from HK by command, because Target only
 * shows the window to a signed in account. Without it the announcement still
 * goes out; the two reminders are simply not scheduled, which is the right
 * failure: being late to announce costs more than missing a reminder.
 *
 * The night reminder is skipped when it would land too close to either the
 * announcement or the closing post (see nightReminderAt).
 *
 * `openedAt` is when the draw was announced. The ticker builds reminders days
 * later, and timing them from the tick rather than the announcement would
 * move them.
 */
export function buildRafflePosts({ items, now, closesAt = null, openedAt = now }) {
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

  const night = nightReminderAt(openedAt, closesAt);
  if (night) {
    posts.push({
      slot: 'night',
      dueAt: night,
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
 * night reminder is deliberately not one: members already got the
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
/**
 * What happens if you win.
 *
 * On the member and Reddit posts but NOT the tweets: those are already near
 * the character limit with the deadline in the opening line, and the people
 * who need this are the ones deciding whether to enter rather than the ones
 * scrolling past.
 */
export const WINNERS_NOTE = 'Winners will have 24 hours to complete their purchase if selected!';

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
        '',
        WINNERS_NOTE,
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
        '',
        WINNERS_NOTE,
      ].join('\n'),
    },
  ];
}
