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

const EXCLUDE = [
  /\brepack\b/i, /\bmystery\s*(power\s*)?box\b/i, /\bmystery\s*pack\b/i,
];

// Walmart puts plenty of non card merchandise through the same draws. None of
// it belongs in a PokeFinder post, so it is dropped rather than categorised.
const NOT_CARDS = [
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
  if (EXCLUDE.some((re) => re.test(t))) return 'excluded';
  if (NOT_CARDS.some((re) => re.test(t))) return 'excluded';
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
export function parseEmbed(embed, { now = DateTime.now() } = {}) {
  const author = embed?.author?.name?.trim();
  if (author !== DRAW_AUTHOR) return null;

  const f = fieldMap(embed);
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
    classification: classify(title),
    startsAt: win.start,
    endsAt: win.end,
    drawDate: win.start.setZone('America/New_York').toISODate(),
    suspect: win.suspect,
  };
}
