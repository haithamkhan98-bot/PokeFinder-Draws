import { DateTime } from 'luxon';
import { parsePrice, suggestName, isNowLive, resolveLink, NOT_CARDS } from './parse.js';

export const QUEUE_AUTHOR = 'Walmart Droplist';

// The late queue arrives through the restock monitor rather than the Droplist
// one, flagged in the title and in Type. Everything else from this author is
// an ordinary restock and must stay ignored.
export const POTENTIAL_AUTHOR = 'Walmart US V2';
export const POTENTIAL_PREFIX = /^\s*\[\s*potential\s+wm\s+droplist\s*\]\s*/i;

// Walmart's collectibles queue drops at 9PM Eastern on Wednesdays.
export const DROP_HOUR = 21;
export const DROP_WEEKDAY = 3; // luxon: Monday is 1

/**
 * The drop these items are queueing for.
 *
 * Queue embeds carry no date at all, unlike draw embeds, so it has to be
 * worked out. The next Wednesday 9PM Eastern that has not already passed:
 * embeds landing on Tuesday evening point at the following night, and embeds
 * landing after a Wednesday drop roll on to the week after.
 */
export function nextDropAt(now = DateTime.now()) {
  const et = now.setZone('America/New_York');
  let drop = et.set({ hour: DROP_HOUR, minute: 0, second: 0, millisecond: 0 });
  const ahead = (DROP_WEEKDAY - drop.weekday + 7) % 7;
  drop = drop.plus({ days: ahead });
  if (drop <= et) drop = drop.plus({ days: 7 });
  return drop;
}

// Upper Deck and College products never appear in PokeFinder content.
const EXCLUDE = [/\bupper\s*deck\b/i, /\bcollege\b/i, /\bncaa\b/i];

const GAMES = [
  ['pokemon', [/\bpok[eé]mon\b/i, /\bpokemon\b/i, /\bptcg\b/i]],
  ['mtg', [/\bmagic:?\s*the\s*gathering\b/i, /\bmtg\b/i]],
  ['onepiece', [/\bone\s*piece\b/i, /\boptcg\b/i]],
  ['sports', [
    /\btopps\b/i, /\bbowman\b/i, /\bpanini\b/i, /\bprizm\b/i, /\bdonruss\b/i,
    /\bmosaic\b/i, /\boptic\b/i, /\b(nfl|nba|mlb|nhl|wnba)\b/i,
    /\bfootball\b/i, /\bbasketball\b/i, /\bbaseball\b/i, /\bhockey\b/i,
    /\bsoccer\b/i, /\bformula\s*1\b/i, /\bf1\b/i, /\bsports?\s*cards?\b/i,
  ]],
];

/** The group ordering for every queue list and post. */
/**
 * Pokemon leads, then One Piece: it outranks Magic for this audience, so it is
 * named second wherever both appear. This order drives the summary line, the
 * product lists, the group headings and the grid together, so none of them can
 * rank the games differently from the others.
 */
export const GROUP_ORDER = ['pokemon', 'onepiece', 'mtg', 'sports', 'other'];

export const GROUP_LABEL = {
  pokemon: 'Pokemon',
  mtg: 'Magic: The Gathering',
  onepiece: 'One Piece',
  sports: 'Sports Cards',
  other: 'Other',
};

export function classifyQueue(title) {
  const t = title ?? '';
  if (EXCLUDE.some((re) => re.test(t))) return 'excluded';
  // Merchandise before games, or a Pokemon plush classifies as Pokemon. Shares
  // the draw path's list so the two can never disagree about what is a card.
  if (NOT_CARDS.some((re) => re.test(t))) return 'excluded';
  for (const [game, patterns] of GAMES) {
    if (patterns.some((re) => re.test(t))) return game;
  }
  return 'other';
}

/**
 * Turn one Droplist embed into a queue item.
 *
 * Returns null when the embed is not from the queue monitor. Unlike a draw
 * embed there is no time to parse, so the only things that can be missing are
 * the title, the PID and the price.
 */
export function parseQueueEmbed(embed, { now = DateTime.now() } = {}) {
  if (embed?.author?.name?.trim() !== QUEUE_AUTHOR) return null;

  const f = {};
  for (const field of embed?.fields ?? []) {
    if (field?.name) f[String(field.name).trim().toLowerCase()] = String(field.value ?? '').trim();
  }

  // Same as the draws: the monitor re-posts each item when the drop opens.
  // Those are announcements, not new queue items.
  if (isNowLive(f.type)) return null;

  const title = (embed?.title ?? '').trim();
  const pid = f.pid || f.sku;
  const priceDisplay = f.price;

  const missing = [];
  if (!title) missing.push('title');
  if (!pid) missing.push('PID');
  if (!priceDisplay) missing.push('Price');
  if (missing.length) return { error: `queue embed missing ${missing.join(', ')}`, title, pid };

  const dropAt = nextDropAt(now);

  return {
    pid: String(pid).replace(/[^0-9]/g, ''),
    rawTitle: title,
    productName: suggestName(title),
    priceDisplay,
    priceCents: parsePrice(priceDisplay),
    cartLimit: f['cart limit'] ?? null,
    seller: f.seller ?? null,
    imageUrl: embed?.thumbnail?.url ?? embed?.image?.url ?? null,
    sourceUrl: embed?.url ?? null,
    ...resolveLink({ sourceUrl: embed?.url ?? null, pid: String(pid).replace(/[^0-9]/g, '') }),
    classification: classifyQueue(title),
    dropAt,
    dropDate: dropAt.toISODate(),
  };
}

const isCollector = (i) => /\bcollector\b/i.test(i.rawTitle || i.productName || '');
const isToppsFamily = (i) => /\b(topps|bowman|chrome)\b/i.test(i.rawTitle || '');
const isBowmanOrChrome = (i) => /\b(bowman|chrome)\b/i.test(i.rawTitle || '');

const byPriceDesc = (a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0);

/**
 * Sort one group's items.
 *
 * Magic leads with its Collector products, then price descending. Sports cards
 * lead with Topps, and within Topps the Bowman and Chrome titles come first.
 * Everything else is simply most expensive first.
 */
export function sortGroup(game, items) {
  const list = [...items];
  if (game === 'mtg') {
    return list.sort((a, b) => (isCollector(b) - isCollector(a)) || byPriceDesc(a, b));
  }
  if (game === 'sports') {
    return list.sort((a, b) => (isToppsFamily(b) - isToppsFamily(a))
      || (isBowmanOrChrome(b) - isBowmanOrChrome(a))
      || byPriceDesc(a, b));
  }
  return list.sort(byPriceDesc);
}

/** Group the run's items and order both the groups and the items inside them. */
export function groupQueue(items) {
  const groups = [];
  for (const game of GROUP_ORDER) {
    const inGroup = items.filter((i) => i.classification === game);
    if (inGroup.length) groups.push({ game, label: GROUP_LABEL[game], items: sortGroup(game, inGroup) });
  }
  return groups;
}

/** Every postable item, in the order they appear in the lists and the grid. */
export const orderedQueueItems = (items) => groupQueue(items).flatMap((g) => g.items);

/** "24.99 USD / GT Collectibles and Toys" -> { cents, display, seller } */
export function parsePredicted(raw) {
  const text = String(raw ?? '');
  const m = /(\d[\d,]*)(?:\.(\d{1,2}))?\s*(?:usd|\$)?/i.exec(text);
  const slash = text.indexOf('/');
  const seller = slash >= 0 ? text.slice(slash + 1).trim() : null;
  if (!m) return { cents: null, display: null, seller };
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return { cents, display: `$${(cents / 100).toFixed(2)}`, seller };
}

/**
 * The late Walmart queue, announced ten to twenty minutes before it opens.
 *
 * These come from the restock monitor, not the Droplist one, so the author
 * alone cannot identify them. They are marked both in the title and in Type,
 * and either is enough. The price sits in "Predicted Price / Seller" rather
 * than in Price, which reads N/A.
 */
export function parsePotentialQueueEmbed(embed, { now = DateTime.now() } = {}) {
  if (embed?.author?.name?.trim() !== POTENTIAL_AUTHOR) return null;

  const f = {};
  for (const field of embed?.fields ?? []) {
    if (field?.name) f[String(field.name).trim().toLowerCase()] = String(field.value ?? '').trim();
  }

  const rawTitle = (embed?.title ?? '').trim();
  const flagged = POTENTIAL_PREFIX.test(rawTitle) || /potential\s+queue/i.test(f.type ?? '');
  if (!flagged) return null;              // an ordinary restock from the same monitor
  if (isNowLive(f.type)) return null;

  const pid = (f['copyable pid'] || f.pid || '').replace(/[^0-9]/g, '');
  const title = rawTitle.replace(POTENTIAL_PREFIX, '').trim();
  const predicted = parsePredicted(f['predicted price / seller']);

  const missing = [];
  if (!title) missing.push('title');
  if (!pid) missing.push('PID');
  if (missing.length) return { error: `potential queue embed missing ${missing.join(', ')}`, title, pid };

  const dropAt = nextDropAt(now);

  return {
    pid,
    rawTitle: title,
    productName: suggestName(title),
    priceDisplay: predicted.display,
    priceCents: predicted.cents,
    seller: predicted.seller,
    sourceUrl: embed?.url ?? null,
    ...resolveLink({ sourceUrl: embed?.url ?? null, pid }),
    imageUrl: embed?.thumbnail?.url ?? embed?.image?.url ?? null,
    classification: classifyQueue(title),
    potential: true,
    dropAt,
    dropDate: dropAt.toISODate(),
  };
}
