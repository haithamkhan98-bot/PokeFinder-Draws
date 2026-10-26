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
const POKEMON = [/\bpok[eé]mon\b/i, /\bpokemon\b/i, /\bptcg\b/i];

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

export function classify(title) {
  const t = title ?? '';
  if (EXCLUDE.some((re) => re.test(t))) return 'excluded';
  if (POKEMON.some((re) => re.test(t))) return 'pokemon';
  return 'other';
}

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
