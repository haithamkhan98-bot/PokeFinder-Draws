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

/**
 * 30th Celebration leads, then 30th Anniversary, then everything else in the
 * order the items arrived. Used for the headline and, through `itemBlock`,
 * for the product list, so the two can never disagree about what leads.
 */
export const setRank = (s) => {
  if (/30th\s*celebration/i.test(s ?? '')) return 0;
  if (/30th/i.test(s ?? '')) return 1;
  return 2;
};

export function orderedSets(sets) {
  return [...sets].sort((a, b) => setRank(a) - setRank(b) || sets.indexOf(a) - sets.indexOf(b));
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
/**
 * Where a product sits inside its own set.
 *
 * Premium collections lead, then the sealed product in descending size. Tested
 * in this order because the patterns overlap: a Booster Bundle is not a
 * Booster Box, and an Ultra Premium Collection outranks both.
 */
const PRODUCT_RANK = [
  // "Ultra-Premium" and "Ultra Premium" both appear in Walmart titles.
  [/\b(ultra|super)[\s-]*premium\b|\bupc\b|\bspc\b/i, 0],
  [/\bbooster[\s-]*(box|display)\b/i, 1],
  [/\belite[\s-]*trainer[\s-]*box\b|\betb\b/i, 2],
  [/\bbooster[\s-]*bundle\b/i, 3],
  [/\bblister\b|\b3\s*-?\s*pack\b/i, 4],
];

export function productRank(name) {
  const t = String(name ?? '');
  for (const [re, rank] of PRODUCT_RANK) if (re.test(t)) return rank;
  return PRODUCT_RANK.length;
}

/**
 * The Pokemon items in set order.
 *
 * The list used to run in whatever order the monitor happened to send the
 * embeds, so the headline could lead with 30th Celebration while the list
 * below it led with something else. Sorting by the same rank the headline
 * uses keeps them in step. Items inside one set keep their arrival order,
 * and an item with no recognised set sorts last rather than first.
 */
export function orderedPokemon(items) {
  // Sets stay together. Ranking on setRank alone would interleave two sets
  // that share a rank, so the sets are ordered first and each item carries
  // its set's position, not just its set's rank.
  const sets = [...new Set(items.map((i) => i.set).filter(Boolean))];
  const order = new Map(orderedSets(sets).map((name, idx) => [name, idx]));
  const setPos = (i) => (i.set && order.has(i.set) ? order.get(i.set) : order.size);
  const byProduct = (i) => productRank(i.postName ?? i.productName ?? i.rawTitle);
  return [...items].sort((a, b) => setPos(a) - setPos(b)
    || byProduct(a) - byProduct(b)
    || items.indexOf(a) - items.indexOf(b));
}

/**
 * Every item in display order: Pokemon by set and product shape, then the
 * other games. The draw graphic is filled from this too, so the grid and the
 * written list cannot end up in different orders.
 */
export function orderedItems(items) {
  return [...orderedPokemon(items.filter(isPokemon)), ...items.filter((i) => !isPokemon(i))];
}

export function itemBlock(items) {
  const poke = orderedPokemon(items.filter(isPokemon));
  const others = items.filter((i) => !isPokemon(i));
  if (!others.length) return itemLines(poke);
  const tail = `${otherHeading(others)}\n${itemLines(others)}`;
  return poke.length ? `${itemLines(poke)}\n\n${tail}` : tail;
}

/**
 * The non Pokemon names for the headline.
 *
 * One Piece only. Sports cards and other TCGs still appear in the item list
 * under their own heading, but naming them in the headline spends the most
 * valuable words in the post on the thing the audience came for least:
 * "30th Celebration and Sports Cards Draws" reads as a sports post with
 * Pokemon attached.
 *
 * One Piece is the exception because it has its own following in HK's
 * audience and pulls engagement on its own name.
 */
export function otherLabels(items) {
  return items.some((i) => i.classification === 'onepiece') ? ['One Piece TCG'] : [];
}

/**
 * The headline label: Pokemon sets first, then the other categories.
 *
 * Pokemon leads, 30th Anniversary leads the Pokemon sets, and anything non
 * Pokemon is named only after every Pokemon set has been.
 */
/**
 * Draw or Draws.
 *
 * Counted on the items, not on the names in the headline. Walmart runs one
 * draw per product, so four products is four draws however many of them share
 * a set name. It used to count headline labels, which worked only while every
 * category was named there: once sports cards stopped being named, a draw of
 * four products announced itself as a single "Draw".
 */
export function drawNoun(items) {
  // Counted directly: everything reaching here has already been filtered to
  // the postable items, so a second classification check would only add a way
  // to get it wrong.
  return (items ?? []).length > 1 ? 'Draws' : 'Draw';
}

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
/**
 * The reminder schedule per channel.
 *
 * PokemonFindr and CollectFinder both carry every draw, so an identical set of
 * posts at identical times means anyone following both sees the same tweet
 * twice at the same minute. CollectFinder therefore runs its own intervals.
 *
 * `outMinutes` and `leftMinutes` appear in the wording as well as the time, so
 * the two always move together and a reminder cannot claim an interval it is
 * not actually sent at.
 */
export const SCHEDULES = {
  default: { morningHour: 9, outMinutes: 10, leftMinutes: 30, overOffset: 0 },
  collectfinder: { morningHour: 11, morningMinute: 30, outMinutes: 30, leftMinutes: 15, overOffset: 15 },
};

export function buildPosts({ items, sets, startsAt, endsAt, variant = 'default' }) {
  const plan = SCHEDULES[variant] ?? SCHEDULES.default;
  const label = headlineLabel(sets, items);
  const noun = drawNoun(items);
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
      dueAt: et.set({
        hour: plan.morningHour, minute: plan.morningMinute ?? 0, second: 0, millisecond: 0,
      }),
      text: join(
        `💫 Reminder! ${label} Walmart ${noun} Going Live Today at ${when}!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      slot: 'out',
      dueAt: et.minus({ minutes: plan.outMinutes }),
      text: join(
        `💫 Reminder: ${label} Walmart ${noun} Going Live in ${plan.outMinutes} Minutes!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      // One minute before the draw opens, not at the start time. The same on
      // both channels: this is the moment, and offsetting it just makes one
      // account late.
      slot: 'going_live',
      dueAt: et.minus({ minutes: 1 }),
      text: join(
        `💫 Walmart ${label} ${noun} Going Live! Entries Accepted for 1 Hour!`,
        link, lines, TIPS, HASHTAGS,
      ),
    },
    {
      slot: 'left',
      dueAt: endsAt.setZone('America/New_York').minus({ minutes: plan.leftMinutes }),
      text: join(
        `💫 ${plan.leftMinutes} Minutes Left to Enter the Walmart ${label} ${noun}!`,
        link, lines, HASHTAGS,
      ),
    },
    {
      // Carries the image but no link, so it ends at #Pokemon with no #ad.
      slot: 'over',
      dueAt: endsAt.setZone('America/New_York').plus({ minutes: plan.overOffset }),
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
  const noun = drawNoun(items);
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
  const noun = drawNoun(items);
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
      // An hour out, not 9AM. Members get the announcement the moment the
      // draw is known and one reminder close enough to act on.
      slot: 'one_hour',
      dueAt: et.minus({ hours: 1 }),
      text: [
        `# Reminder: Walmart Draws Go Live in 1 Hour at ${when}`,
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
      // On the hour, not a minute early like the tweet: the tweet gets ahead
      // of the draw on purpose, this one marks it actually opening.
      slot: 'going_live',
      dueAt: et,
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
      // Anchored to the close rather than to the open, so a draw that ever
      // runs longer than an hour still gets its reminder in the last ten.
      slot: 'ten_left',
      dueAt: endsAt.setZone('America/New_York').minus({ minutes: 10 }),
      text: [
        '# 10 Minutes Left to Enter the Walmart Draws',
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
