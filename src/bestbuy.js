/**
 * The BestBuy in store Daily Summary.
 *
 * One embed per product, each listing every state that is getting stock and
 * how many units. They land in a burst around 1AM and are not posted every
 * day. Nothing is published until 7AM, so unlike the draws there is no race:
 * items are collected against the night they belong to and the post is
 * assembled when the 7AM slot comes round.
 */
import { DateTime } from 'luxon';
import { NOT_CARDS } from './parse.js';

export const SUMMARY_AUTHOR = 'BestBuy US Instore Summary';
export const SUMMARY_TYPE = /daily\s+summary/i;

/** The hour the digest goes out, Eastern. */
export const POST_HOUR = Number(process.env.BESTBUY_POST_HOUR ?? 7);

export const REGIONS = {
  Northeast: 'ME NH VT MA RI CT NY NJ PA',
  Southeast: 'DE MD DC VA WV NC SC GA FL KY TN AL MS AR LA',
  Midwest: 'OH MI IN IL WI MN IA MO ND SD NE KS',
  Southwest: 'TX OK NM AZ',
  West: 'CO WY MT ID UT NV WA OR CA AK HI',
};

const REGION_OF = {};
for (const [region, states] of Object.entries(REGIONS)) {
  for (const s of states.split(' ')) REGION_OF[s] = region;
}

export const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
  Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

/** The next POST_HOUR Eastern that has not already passed. */
export function nextPostAt(now = DateTime.now()) {
  const et = now.setZone('America/New_York');
  let at = et.set({ hour: POST_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (at <= et) at = at.plus({ days: 1 });
  return at;
}

/**
 * The night a summary belongs to, as the date of the post it will go out in.
 * Embeds at 1AM Saturday and 3AM Saturday share a key and share a post.
 */
export const summaryDate = (now = DateTime.now()) => nextPostAt(now).toISODate();

/**
 * "California [242]\nTexas [102]" -> { CA: 242, TX: 102 }.
 *
 * The monitor renders the states in two columns, which arrive as two separate
 * fields with the same name. Both are passed in and merged.
 */
export function parseStates(...blocks) {
  const stock = {};
  const unknown = [];
  for (const block of blocks) {
    for (const line of String(block ?? '').split('\n')) {
      const m = line.match(/^\s*(.+?)\s*\[\s*([\d,]+)\s*\]\s*$/);
      if (!m) continue;
      const abbr = STATE_ABBR[m[1].trim()];
      if (!abbr) { unknown.push(m[1].trim()); continue; }
      stock[abbr] = (stock[abbr] ?? 0) + Number(m[2].replace(/,/g, ''));
    }
  }
  return { stock, unknown };
}

/** { Midwest: 1160, West: 883, ... }, biggest first. */
export function byRegion(stock) {
  const totals = {};
  for (const [abbr, n] of Object.entries(stock)) {
    const r = REGION_OF[abbr];
    if (r) totals[r] = (totals[r] ?? 0) + n;
  }
  return Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1]));
}

/** Merchandise is dropped. Everything else the monitor reports is kept. */
export const isMerch = (title) => NOT_CARDS.some((re) => re.test(String(title ?? '')));

/**
 * Turn one Daily Summary embed into an item, or null when the embed is not one.
 */
export function parseSummaryEmbed(embed, { now = DateTime.now() } = {}) {
  if (embed?.author?.name?.trim() !== SUMMARY_AUTHOR) return null;

  const f = {};
  const stateBlocks = [];
  for (const field of embed?.fields ?? []) {
    const name = String(field?.name ?? '').trim().toLowerCase();
    const value = String(field?.value ?? '').trim();
    if (!name) continue;
    if (name === 'states [stock]') { stateBlocks.push(value); continue; }
    f[name] = value;
  }

  if (!SUMMARY_TYPE.test(f.type ?? '')) return null;

  const title = (embed?.title ?? '').trim();
  const missing = [];
  if (!title) missing.push('title');
  if (!f.sku) missing.push('SKU');
  if (!stateBlocks.length) missing.push('States [Stock]');
  if (missing.length) return { error: `summary embed missing ${missing.join(', ')}`, title, sku: f.sku ?? null };

  const { stock, unknown } = parseStates(...stateBlocks);
  if (!Object.keys(stock).length) {
    return { error: 'summary embed listed no readable states', title, sku: f.sku };
  }

  return {
    sku: String(f.sku).replace(/[^0-9]/g, ''),
    rawTitle: title,
    link: embed?.url ?? null,
    imageUrl: embed?.thumbnail?.url ?? null,
    priceDisplay: f.price ?? null,
    stock,
    units: Object.values(stock).reduce((a, b) => a + b, 0),
    states: Object.keys(stock).length,
    regions: byRegion(stock),
    unknownStates: unknown,
    merch: isMerch(title),
    postDate: summaryDate(now),
    postAt: nextPostAt(now),
  };
}
