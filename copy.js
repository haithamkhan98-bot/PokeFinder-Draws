/**
 * The post copy.
 *
 * Every string here is taken verbatim from the draw sets HK has already
 * published. The wording is settled and is not to be improved on: this module
 * only substitutes the set names, the date, the times and the item list.
 */

export const DRAW_LINK_TWEETS = 'https://howl.link/r5frrzi6qe8hx';
export const DRAW_LINK_DISCORD = 'https://howl.link/swe1iqp31stef';
export const WINS_LINK = 'https://buff.ly/xswHYG8';

export const TIPS = [
  'Tips for Success:',
  '• Save your delivery address and default credit or debit card on your Walmart account before entering',
  '• PayPal does not work, so a credit or debit card must be saved',
  '• If your entry gets rejected, remove and re-enter your address in settings and set it as default',
  '• Entries stay open for 1 hour and the site slows down, so there is no rush',
].join('\n');

export const BOOKMARK = "🛎️ Bookmark & Follow, We'll Post When The Draw Goes Live! We'll Also Post Any New Draws That Get Added!";

const HASHTAGS = '#Pokemon #ad';

const clock = (dt) => {
  const h = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const suffix = dt.hour < 12 ? 'AM' : 'PM';
  return dt.minute === 0 ? `${h}${suffix}` : `${h}:${dt.toFormat('mm')}${suffix}`;
};

/** "5PM EST / 2PM PST" */
export function timeLabel(startsAt) {
  const et = startsAt.setZone('America/New_York');
  const pt = startsAt.setZone('America/Los_Angeles');
  return `${clock(et)} EST / ${clock(pt)} PST`;
}

/** "10/26", the short form the announcement uses. */
export const shortDate = (startsAt) => startsAt.setZone('America/New_York').toFormat('M/d');

/**
 * The set names, 30th Anniversary always first.
 *
 * A draw covering more than one set names them all, joined the way a person
 * would write them rather than with commas throughout.
 */
export const joinEnglish = (list) => {
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

export function orderedSets(sets) {
  return [...sets].sort((a, b) => {
    const rank = (s) => (/30th/i.test(s) ? 0 : 1);
    return rank(a) - rank(b) || sets.indexOf(a) - sets.indexOf(b);
  });
}

export const pokemonSetsLabel = (sets) => joinEnglish(orderedSets(sets));

/** "• Prismatic Evolutions Booster Bundle 2-Pack $79.94" per item. */
export const itemLines = (items) => items.map((i) => `• ${i.postName} ${i.priceDisplay}`).join('\n');

const isPokemon = (i) => i.classification === 'pokemon' || !i.classification;

/**
 * The subheading above the non Pokemon items.
 *
 * Named when the draw's non Pokemon items are all of one kind, and the generic
 * heading when they are mixed.
 */
export function otherHeading(others) {
  const kinds = new Set(others.map((i) => i.classification));
  if (kinds.size === 1) {
    if (kinds.has('onepiece')) return 'One Piece TCG Draws';
    if (kinds.has('sports')) return 'Sports Card Draws';
  }
  return 'Other TCG Draws';
}

/**
 * The product list.
 *
 * Pokemon first and unlabelled, then a blank line, then the non Pokemon items
 * under their subheading. Pokemon is always the lead, so it never gets a
 * heading of its own.
 */
export function itemBlock(items) {
  const poke = items.filter(isPokemon);
  const others = items.filter((i) => !isPokemon(i));
  if (!others.length) return itemLines(poke);
  const tail = `${otherHeading(others)}\n${itemLines(others)}`;
  return poke.length ? `${itemLines(poke)}\n\n${tail}` : tail;
}

/** The non Pokemon names for the headline, in their fixed order. */
export function otherLabels(items) {
  const has = (c) => items.some((i) => i.classification === c);
  const out = [];
  if (has('onepiece')) out.push('One Piece TCG');
  if (has('sports')) out.push('Sports Cards');
  if (has('othertcg')) out.push('Other TCG');
  return out;
}

/**
 * The headline label: Pokemon sets first, then the other categories.
 *
 * Pokemon leads, 30th Anniversary leads the Pokemon sets, and anything non
 * Pokemon is named only after every Pokemon set has been.
 */
export function headlineLabel(sets, items) {
  // One flat list joined once. Joining the Pokemon sets first and then joining
  // that result with the other categories produces a nested "and".
  return joinEnglish([...orderedSets(sets), ...otherLabels(items)]);
}

const join = (...blocks) => blocks.filter(Boolean).join('\n\n');

/**
 * The seven posts for one draw day.
 *
 * `draw` is the word Draw or Draws: singular when the run covers one set, plural
 * when it covers several, matching how HK writes them.
 */
export function buildPosts({ items, sets, startsAt, endsAt }) {
  const label = headlineLabel(sets, items);
  // Plural once the draw spans more than one named thing, whether that is two
  // Pokemon sets or one set plus a non Pokemon category.
  const named = (sets.length || 0) + otherLabels(items).length;
  const noun = named > 1 ? 'Draws' : 'Draw';
  const lines = itemBlock(items);
  const when = timeLabel(startsAt);
  const link = `Enter Draw Here: ${DRAW_LINK_TWEETS}`;

  const et = startsAt.setZone('America/New_York');

  return [
    {
      slot: 'announcement',
      dueAt: null,
      text: join(
        `💫 New ${label} Walmart ${noun} Beginning ${shortDate(startsAt)} at ${when}!`,
        link, lines, BOOKMARK, HASHTAGS,
      ),
    },
    {
      slot: 'morning',
      dueAt: et.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }),
      text: join(
        `💫 Reminder! ${label} Walmart ${noun} Going Live Today at ${when}!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      slot: 'ten_minutes',
      dueAt: et.minus({ minutes: 10 }),
      text: join(
        `💫 Reminder: ${label} Walmart ${noun} Going Live in 10 Minutes!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      // One minute before the draw opens, not at the start time.
      slot: 'going_live',
      dueAt: et.minus({ minutes: 1 }),
      text: join(
        `💫 Walmart ${label} ${noun} Going Live! Entries Accepted for 1 Hour!`,
        link, lines, TIPS, HASHTAGS,
      ),
    },
    {
      slot: 'thirty_left',
      dueAt: et.plus({ minutes: 30 }),
      text: join(
        `💫 30 Minutes Left to Enter the Walmart ${label} ${noun}!`,
        link, lines, HASHTAGS,
      ),
    },
    {
      // Carries the image but no link, so it ends at #Pokemon with no #ad.
      slot: 'over',
      dueAt: endsAt.setZone('America/New_York'),
      text: join(
        "💫 Today's Walmart Draw is now over! We will post as soon as wins start going out!",
        "Follow & Turn Notifications On! We'll post the next draws as soon as they're announced!",
        '#Pokemon',
      ),
    },
  ];
}

/**
 * The wins post. A draft only, never scheduled, and it carries no image:
 * HK sends it by hand once wins actually start landing.
 */
export const winsPost = () => join(
  "✨️Wins from Today's Walmart Draws Are Starting to Go Out! Keep an Eye on Your Emails! "
  + 'Wins Likely To Go Out Over the Next Few Hours!',
  `Check Here: ${WINS_LINK}`,
  HASHTAGS,
);

/** Alt text for the attached draw image. */
export const altTextFor = ({ items, startsAt }) => {
  const et = startsAt.setZone('America/New_York');
  return `${items.map((i) => i.postName).join(', ')} Walmart draw starting `
    + `${et.toFormat('LLLL d')} at ${clock(et)} EST`;
};

/** The Discord post for HK's server. Returned as text for him to paste. */
export function discordPost({ items, sets, startsAt }) {
  const label = headlineLabel(sets, items);
  const noun = (sets.length || 0) + otherLabels(items).length > 1 ? 'Draws' : 'Draw';
  const epoch = Math.floor(startsAt.toSeconds());
  return [
    `# New Walmart Draws Beginning ${shortDate(startsAt)} at ${timeLabel(startsAt)}`,
    '',
    `**${label} ${noun} on ${shortDate(startsAt)} at ${timeLabel(startsAt)}: `
    + `<t:${epoch}:F> (<t:${epoch}:R>)** @PokeFinder+`,
    '',
    '**Items for Upcoming Draw:**',
    itemBlock(items),
    `# Draw Link: [Walmart Collectibles Draw](${DRAW_LINK_DISCORD})`,
  ].join('\n');
}

/** @deprecated use headlineLabel. Kept because the tests pin set ordering. */
export { pokemonSetsLabel as setsLabel };

const epoch = (dt) => Math.floor(dt.toSeconds());

/**
 * The member facing Discord posts for one draw day.
 *
 * Modelled on the announcement HK already uses: a plain title line, the sets
 * and a live Discord timestamp in bold, the role mention, the items, then the
 * link. The timestamps render in each member's own timezone and count
 * themselves down, so nothing goes stale between writing and sending.
 *
 * `role` is the mention string. Discord only pings when it is given the role's
 * ID as <@&id>; the literal text "@PokeFinder+" is just text.
 */
export function buildDiscordPosts({ items, sets, startsAt, endsAt, role }) {
  const label = headlineLabel(sets, items);
  const noun = (sets.length || 0) + otherLabels(items).length > 1 ? 'Draws' : 'Draw';
  const lines = itemBlock(items);
  const link = `# Draw Link: [Walmart Collectibles Draw](${DRAW_LINK_DISCORD})`;
  const start = epoch(startsAt);
  const end = epoch(endsAt);
  const et = startsAt.setZone('America/New_York');
  const when = timeLabel(startsAt);

  return [
    {
      slot: 'announcement',
      dueAt: null,
      text: [
        `# New Walmart Draws Beginning ${shortDate(startsAt)} at ${when}`,
        '',
        `**${label} ${noun} on ${shortDate(startsAt)} at ${when}: <t:${start}:F> (<t:${start}:R>)** ${role}`,
        '',
        '**Items for Upcoming Draw:**',
        lines,
        link,
      ].join('\n'),
    },
    {
      slot: 'morning',
      dueAt: et.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }),
      text: [
        `# Reminder: Walmart Draws Go Live Today at ${when}`,
        '',
        `**${label} ${noun} opens <t:${start}:F> (<t:${start}:R>)** ${role}`,
        '',
        "**Items for Today's Draw:**",
        lines,
        '',
        TIPS.replace('Tips for Success:', '**Tips for Success:**'),
        link,
      ].join('\n'),
    },
    {
      // One minute before the draw opens, matching the tweet.
      slot: 'going_live',
      dueAt: et.minus({ minutes: 1 }),
      text: [
        '# Walmart Draws Going Live! Entries Accepted for 1 Hour',
        '',
        `**${label} ${noun} closes <t:${end}:F> (<t:${end}:R>)** ${role}`,
        '',
        '**Items in This Draw:**',
        lines,
        link,
      ].join('\n'),
    },
    {
      slot: 'thirty_left',
      dueAt: et.plus({ minutes: 30 }),
      text: [
        '# 30 Minutes Left to Enter the Walmart Draws',
        '',
        `**${label} ${noun} closes <t:${end}:R>** ${role}`,
        '',
        '**Items in This Draw:**',
        lines,
        link,
      ].join('\n'),
    },
  ];
}
