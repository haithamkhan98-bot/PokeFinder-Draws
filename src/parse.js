import { DateTime } from 'luxon';

export const DRAW_AUTHOR = 'Walmart Draws';

// Only these two zones have ever appeared on a Walmart draw embed, but the
// others are here so an unexpected abbreviation fails loudly rather than
// silently being treated as UTC.
const ZONES = {
  PDT: 'America/Los_Angeles', PST: 'America/Los_Angeles',
  MDT: 'America/Denver',      MST: 'America/Denver',
  CDT: 'America/Chicago',     CST: 'America/Chicago',
  EDT: 'America/New_York',    EST: 'America/New_York',
};

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// "Oct 26, 2:00pm - 3:00pm PDT"
const TIME_RE = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*([ap]m)\s*[-–—to]+\s*(\d{1,2}):(\d{2})\s*([ap]m)\s*([A-Z]{3,4})$/i;

// Repacks and mystery boxes never belong in PokeFinder content, draws or
// queue. Exported so the queue path applies exactly this list rather than
// keeping a second copy that can drift.
export const REPACKS = [
  /\brepack\b/i, /\bmystery\s*(power\s*)?box\b/i, /\bmystery\s*pack\b/i,
];

/**
 * Product shapes that are trading card products whatever else the title says.
 *
 * Checked before NOT_CARDS, because NOT_CARDS matches words that appear in
 * genuine TCG product names. "30th Celebration Figure Collection, Mew and
 * Mewtwo" is a box of cards, but it matched the figure pattern meant for Funko
 * and Nendoroid and was dropped from a live draw: missing from the tweets, the
 * Discord posts and the grid, with only one line in the run summary saying so.
 *
 * Narrow on purpose. These are product line names, not words that merely
 * co-occur with cards, so a Pikachu plush or a Funko of a card character is
 * still excluded.
 */
export const TCG_PRODUCTS = [
  /\belite\s*trainer\s*box\b/i, /\betb\b/i, /\bbooster\b/i, /\bblister\b/i,
  /\b(ultra\s*)?premium\s*collection\b/i, /\bfigure\s*collection\b/i,
  /\bposter\s*collection\b/i, /\bbinder\s*collection\b/i,
  /\bknock\s*out\s*collection\b/i, /\bbattle\s*decks?\b/i,
  /\bmini\s*tins?\b/i, /\bcollection\s*box\b/i, /\bcard\s*game\b/i,
  /\btrading\s*cards?\b/i, /\btcg\b/i, /\bsleeved\b/i, /\bdisplay\s*box\b/i,
];

// Walmart puts plenty of non card merchandise through the same draws. None of
// it belongs in a PokeFinder post, so it is dropped rather than categorised.
export const NOT_CARDS = [
  /\bnendoroid\b/i, /\bfigur(e|ine)s?\b/i, /\bfunko\b/i, /\bpop!\b/i,
  /\bplush(ie)?\b/i, /\bstatue\b/i, /\bplaymat\b/i, /\bbackpack\b/i,
  /\bkeychain\b/i, /\blego\b/i, /\bpuzzle\b/i, /\bapparel\b/i,
  /\bt-?shirt\b/i, /\bhoodie\b/i, /\bsneakers?\b/i, /\bconsole\b/i,
];

const POKEMON = [/\bpok[eé]mon\b/i, /\bpokemon\b/i, /\bptcg\b/i];
const ONE_PIECE = [/\bone\s*piece\b/i, /\boptcg\b/i];
const SPORTS = [
  /\btopps\b/i, /\bbowman\b/i, /\bpanini\b/i, /\bprizm\b/i, /\bdonruss\b/i,
  /\bupper\s*deck\b/i, /\bsports?\s*cards?\b/i, /\bmosaic\b/i, /\boptic\b/i,
  /\b(nfl|nba|mlb|nhl|wnba)\b/i, /\bfootball\b/i, /\bbasketball\b/i,
  /\bbaseball\b/i, /\bhockey\b/i, /\bsoccer\b/i,
];
const OTHER_TCG = [
  /\bmagic:?\s*the\s*gathering\b/i, /\bmtg\b/i, /\blorcana\b/i,
  /\byu-?gi-?oh\b/i, /\bdigimon\b/i, /\bweiss\s*schwarz\b/i,
  /\bdragon\s*ball\b/i, /\bflesh\s*and\s*blood\b/i, /\bstar\s*wars\s*unlimited\b/i,
  /\bgundam\b/i, /\briftbound\b/i,
];

function to24(hour, meridiem) {
  const h = Number(hour) % 12;
  return meridiem.toLowerCase() === 'pm' ? h + 12 : h;
}

/**
 * Parse the Time field into an absolute start and end.
 *
 * The embed carries no year, and the window is quoted in Pacific while every
 * post we schedule is Eastern. We therefore build the window in the embed's own
 * zone and let luxon convert. The year is inferred as the nearest occurrence of
 * that date rather than assumed to be the current one, so a draw announced in
 * late December for early January does not land eleven months in the past.
 */
export function parseWindow(raw, now = DateTime.now()) {
  const m = TIME_RE.exec((raw ?? '').trim());
  if (!m) return { error: `unrecognised time format: ${JSON.stringify(raw)}` };

  const [, monthWord, day, sh, sm, sMer, eh, em, eMer, zoneAbbr] = m;
  const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return { error: `unrecognised month: ${monthWord}` };

  const zone = ZONES[zoneAbbr.toUpperCase()];
  if (!zone) return { error: `unrecognised timezone: ${zoneAbbr}` };

  const build = (year) => DateTime.fromObject(
    { year, month, day: Number(day), hour: to24(sh, sMer), minute: Number(sm) },
    { zone },
  );

  // Candidate years: last, this, next. Pick the one closest to now that is not
  // more than 7 days in the past.
  const base = now.setZone(zone).year;
  const candidates = [base - 1, base, base + 1]
    .map(build)
    .filter((d) => d.isValid && d.diff(now, 'days').days > -7)
    .sort((a, b) => Math.abs(a.diff(now).toMillis()) - Math.abs(b.diff(now).toMillis()));

  if (!candidates.length) return { error: `could not place ${raw} on a plausible year` };
  const start = candidates[0];

  let end = start.set({ hour: to24(eh, eMer), minute: Number(em) });
  if (end <= start) end = end.plus({ days: 1 }); // window crossing midnight

  const daysAhead = start.diff(now, 'days').days;
  const suspect = daysAhead > 60
    ? `window is ${Math.round(daysAhead)} days away, which is further out than any draw we have seen`
    : null;

  return { start, end, zone, suspect };
}

/**
 * Which block of the post an item belongs to.
 *
 * Pokemon leads every post. One Piece, sports cards and the other card games
 * follow under a subheading. Repacks and non card merchandise are dropped.
 * Anything unrecognised comes back as 'unknown' rather than being quietly
 * grouped, so a game we have no pattern for is reported instead of lost.
 */
export function classify(title) {
  const t = title ?? '';
  // Merchandise is tested before the games, or a Pokemon branded plush or
  // figure would be taken for a postable Pokemon card product.
  if (REPACKS.some((re) => re.test(t))) return 'excluded';
  // A card product is never merchandise, however its product line is named.
  const isCardProduct = TCG_PRODUCTS.some((re) => re.test(t));
  if (!isCardProduct && NOT_CARDS.some((re) => re.test(t))) return 'excluded';
  if (POKEMON.some((re) => re.test(t))) return 'pokemon';
  if (ONE_PIECE.some((re) => re.test(t))) return 'onepiece';
  if (SPORTS.some((re) => re.test(t))) return 'sports';
  if (OTHER_TCG.some((re) => re.test(t))) return 'othertcg';
  return 'unknown';
}

/** The categories that make it into a post, in the order they appear. */
export const POSTABLE = ['pokemon', 'onepiece', 'sports', 'othertcg'];
export const isPostable = (c) => POSTABLE.includes(c);

/**
 * Light cleanup only. Set resolution and the final tweet wording stay with the
 * agent in stage four; this just strips the prefixes that are always noise so
 * the stored name is readable.
 */
export function suggestName(title) {
  return (title ?? '')
    .replace(/^pok[eé]mon\s+(tcg|trading card game)\s*:\s*/i, '')
    .replace(/^pok[eé]mon\s*:\s*/i, '')
    .replace(/^(scarlet\s*&\s*violet|sword\s*&\s*shield|mega evolution)\s*[-–:]\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parsePrice(display) {
  const m = /(\d[\d,]*)(?:\.(\d{1,2}))?/.exec(display ?? '');
  if (!m) return null;
  return Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** True for the second embed a monitor posts when an item actually opens. */
/**
 * Hosts that mean a link is already an affiliate link.
 *
 * The monitor can be configured to make each embed's title link an affiliate
 * link. When it has been, that link arrives with the item and is better than
 * anything reconstructed: it is current, it needs no lookup, and it cannot
 * drift out of step with a spreadsheet.
 */
export const AFFILIATE_HOSTS = (process.env.AFFILIATE_HOSTS
  || 'howl.link,mavely.app.link,go.magik.ly,shopmy.us')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/**
 * Substrings that mark a link as somebody else's.
 *
 * A Droplist embed sometimes carries a link containing "zephyr". It sits on an
 * affiliate host, so the host check alone accepts it, but it is not our link:
 * publishing it credits someone else for the sale. Treat it as no link at all
 * and fall back to the plain PokeFinder form.
 *
 * Matched anywhere in the URL, not just the hostname, because these turn up as
 * a path segment or a query parameter as well as a subdomain.
 */
export const AFFILIATE_BLOCKLIST = (process.env.AFFILIATE_BLOCKLIST || 'zephyr')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function isBlockedLink(url) {
  const u = String(url ?? '').toLowerCase();
  return AFFILIATE_BLOCKLIST.some((s) => u.includes(s));
}

export function isAffiliateLink(url) {
  // The blocklist is checked here rather than in resolveLink so that every
  // caller is covered, now and later.
  if (isBlockedLink(url)) return false;
  try {
    return AFFILIATE_HOSTS.some((h) => new URL(url).hostname.toLowerCase().endsWith(h));
  } catch {
    return false;
  }
}

/**
 * The link to publish for an item.
 *
 * Three sources, in order of how much they are trusted:
 *  1. An affiliate link on the embed. HK set that by hand for this drop, so
 *     it is the most specific thing anyone knows about this item.
 *  2. HK's sheet, keyed on SKU. Most items have a link here and no link on
 *     the embed, which is the gap this closes: without it they post as plain
 *     PokeFinder URLs and earn nothing.
 *  3. The standard PokeFinder form built from the PID, as before.
 *
 * `sheet` is a Map from loadAffiliateLinks, or null when no sheet is
 * configured, in which case this behaves exactly as it did before.
 */
export function resolveLink({ sourceUrl, pid, sheet = null }) {
  if (sourceUrl && isAffiliateLink(sourceUrl)) return { link: sourceUrl, affiliate: true };
  const fromSheet = sheet?.get(String(pid).replace(/[^0-9]/g, ''))?.affiliate;
  if (fromSheet) return { link: fromSheet, affiliate: true, fromSheet: true };
  return { link: `https://www.walmart.com/ip/PokeFinder/${pid}`, affiliate: false };
}

export const isNowLive = (type) => /\bnow\s+live\b/i.test(String(type ?? ''));

function fieldMap(embed) {
  const out = {};
  for (const f of embed?.fields ?? []) {
    if (f?.name) out[String(f.name).trim().toLowerCase()] = String(f.value ?? '').trim();
  }
  return out;
}

/**
 * Turn one Discord embed into a draw item.
 *
 * Returns null when the embed is not a draw at all, which is the common case
 * since the restock monitor posts to the same channel. Returns an object with
 * `error` when it looks like a draw but could not be read, so the caller can
 * alert rather than drop it silently.
 */
export function parseEmbed(embed, { now = DateTime.now(), sheet = null } = {}) {
  const author = embed?.author?.name?.trim();
  if (author !== DRAW_AUTHOR) return null;

  const f = fieldMap(embed);

  // The monitor posts a second embed for the same product when the draw opens,
  // marked "Raffle Now Live" and carrying no Time. Without this it looks like
  // a draw embed that failed to parse, and every item produces a spurious
  // alert at the moment the draw goes live.
  if (isNowLive(f.type)) return null;
  const title = (embed?.title ?? '').trim();
  const pid = f.pid || f.sku;
  const priceDisplay = f.price;

  const missing = [];
  if (!title) missing.push('title');
  if (!pid) missing.push('PID');
  if (!priceDisplay) missing.push('Price');
  if (!f.time) missing.push('Time');
  if (missing.length) return { error: `draw embed missing ${missing.join(', ')}`, title, pid };

  const win = parseWindow(f.time, now);
  if (win.error) return { error: win.error, title, pid };

  return {
    pid: String(pid).replace(/[^0-9]/g, ''),
    rawTitle: title,
    productName: suggestName(title),
    priceDisplay,
    priceCents: parsePrice(priceDisplay),
    imageUrl: embed?.thumbnail?.url ?? embed?.image?.url ?? null,
    sourceUrl: embed?.url ?? null,
    ...resolveLink({ sourceUrl: embed?.url ?? null, pid: String(pid).replace(/[^0-9]/g, ''), sheet }),
    classification: classify(title),
    startsAt: win.start,
    endsAt: win.end,
    drawDate: win.start.setZone('America/New_York').toISODate(),
    suspect: win.suspect,
  };
}
