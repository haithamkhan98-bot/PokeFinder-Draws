import { DateTime } from 'luxon';
import { parseCloseText, tcinFromUrl } from './target-close.js';
import { targetUrl } from './target.js';
import { raffleLink } from './target-raffle.js';
import { classify, isBlockedLink } from './parse.js';
import { skuKey } from './sheet.js';

/**
 * `!targetdraw`: a Target draw HK starts by hand.
 *
 * For the draws the monitor never sees, or sees late. HK names the items and
 * the close time, and the bot does the rest the same way it does for a draw
 * the monitor caught: the announcement on both X accounts and the member
 * Discord now, a 10PM reminder the night before on X, and the hour warning on
 * X and Discord.
 *
 *   !targetdraw Nov 19 11am
 *   1012850570
 *   1012850572
 *   1012663804 30th Celebration Ditto Premium Collection
 *
 * One item per line, a TCIN or a Target URL, optionally followed by an
 * affiliate link and/or the name to post it under. Everything left out comes
 * from the Target tab of the sheet, then from the last time the monitor saw
 * the item, then from Target's own page.
 *
 * The parsing and resolving live here, apart from Discord and the database,
 * so they can be tested with no bot running.
 */

export const ET = 'America/New_York';
export const MAX_ITEMS = 12;
/** A draw that supposedly runs for over a month is a typo, not a draw. */
export const MAX_DAYS = 30;

const ZONES = {
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  et: ET, est: ET, edt: ET,
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
};
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The close time as HK types it. Eastern unless he names another zone,
 * because Eastern is what every post states.
 *
 *   11/19 11am · 11/19/2026 11:00am · Nov 19 11am · Nov 19 at 11am EST
 *   11am Nov 19 · 10am CT on Nov 19 (Target's own wording)
 *
 * The year is optional, and taken as the next one that puts the time in the
 * future.
 */
export function parseDrawClose(text, { now = DateTime.now() } = {}) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, reason: 'no close time given' };

  const zoneM = raw.match(/\b(ct|cst|cdt|et|est|edt|mt|mst|mdt|pt|pst|pdt)\b/i);
  const zone = zoneM ? ZONES[zoneM[1].toLowerCase()] : ET;
  const timeM = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);

  let month = null;
  let day = null;
  let year = null;
  const numeric = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const named = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i);
  if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
  } else if (named) {
    month = MONTHS[named[1].toLowerCase()];
    day = Number(named[2]);
    if (named[3]) year = Number(named[3]);
  }

  let dt = null;
  if (month && day && timeM) {
    let h = Number(timeM[1]) % 12;
    if (timeM[3].toLowerCase() === 'pm') h += 12;
    const minute = Number(timeM[2] ?? 0);
    for (const y of year ? [year] : [now.year, now.year + 1]) {
      const c = DateTime.fromObject({ year: y, month, day, hour: h, minute }, { zone });
      if (c.isValid && (year || c > now)) { dt = c; break; }
    }
  } else {
    // Target's own phrasing, which always names its zone.
    dt = parseCloseText(raw, { now });
  }

  if (!dt?.isValid) {
    return { ok: false, reason: `could not read "${raw}" as a date and time, try "Nov 19 11am" or "11/19 11am"` };
  }
  if (dt <= now) return { ok: false, reason: `${fmt(dt)} has already passed` };
  if (dt > now.plus({ days: MAX_DAYS })) return { ok: false, reason: `${fmt(dt)} is more than ${MAX_DAYS} days out` };
  return { ok: true, closesAt: dt.setZone(ET) };
}

export const fmt = (dt) => dt.setZone(ET).toFormat("ccc LLL d, h:mma 'ET'");

const isUrl = (s) => /^https?:\/\//i.test(s);
const isTargetUrl = (s) => {
  try { return /(^|\.)target\.com$/i.test(new URL(s).hostname); } catch { return false; }
};

/** One item line: TCIN or Target URL, then an optional link and/or name. */
export function parseItemLine(line) {
  const tokens = String(line ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const [first, ...rest] = tokens;
  const tcin = /^\d{6,12}$/.test(first) ? first : isTargetUrl(first) ? tcinFromUrl(first) : null;
  if (!tcin) return { error: `"${first}" is not a TCIN or a Target product link` };

  let link = null;
  const words = [];
  for (const t of rest) {
    if (isUrl(t) && !link && !isTargetUrl(t)) link = t;
    else if (!isUrl(t)) words.push(t);
  }
  return { tcin, link, name: words.join(' ') || null };
}

/**
 * The whole command, after `!targetdraw`.
 *
 * Multi line: the close time on the first line, an item per line after it.
 * Single line also works for the quick case, with the TCINs after the time:
 * `!targetdraw Nov 19 11am 1012850570 1012850572`.
 */
export function parseDrawCommand(body, { now = DateTime.now() } = {}) {
  const lines = String(body ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, errors: [USAGE] };

  let closeText;
  let itemLines;
  if (lines.length === 1) {
    // TCINs are 8 to 10 digits; nothing in a date or time is that long.
    const tokens = lines[0].split(/\s+/);
    const at = tokens.findIndex((t) => /^\d{8,10}$/.test(t) || isTargetUrl(t));
    if (at === -1) return { ok: false, errors: ['No items given.', USAGE] };
    closeText = tokens.slice(0, at).join(' ');
    itemLines = tokens.slice(at);
  } else {
    [closeText, ...itemLines] = lines;
  }

  const close = parseDrawClose(closeText, { now });
  const errors = close.ok ? [] : [`Close time: ${close.reason}.`];

  const items = [];
  for (const l of itemLines) {
    const p = parseItemLine(l);
    if (!p) continue;
    if (p.error) { errors.push(p.error); continue; }
    if (items.some((i) => i.tcin === p.tcin)) continue;
    items.push(p);
  }
  if (!items.length) errors.push('No items given.');
  if (items.length > MAX_ITEMS) errors.push(`${items.length} items is more than the ${MAX_ITEMS} a grid holds.`);

  return errors.length ? { ok: false, errors } : { ok: true, closesAt: close.closesAt, items };
}

export const USAGE = [
  'Usage, close time first, then one item per line (Eastern unless you name a zone):',
  '```',
  '!targetdraw Nov 19 11am',
  '1012850570',
  '1012850572',
  '1012663804 https://howl.link/abc 30th Celebration Ditto Premium Collection',
  '```',
  'A link or a name after the TCIN overrides the sheet. `!targetdrawpreview` takes the same '
    + 'text and shows the posts without sending anything.',
].join('\n');

/** The sheet row's set and product as one post name. */
export function sheetName(row) {
  if (!row?.product) return { name: null, set: null };
  const set = row.set && !/^misc/i.test(row.set) ? row.set : null;
  const name = set && !row.product.toLowerCase().startsWith(set.toLowerCase())
    ? `${set} ${row.product}` : row.product;
  return { name, set };
}

const goodAffiliate = (u) => isUrl(u) && !isTargetUrl(u) && !isBlockedLink(u);

/**
 * Everything the posts need for each item, from wherever it can be found.
 *
 * Name: HK's own, then the sheet, then the last monitor row, then a recent
 *   monitor embed, then Target's page title. The last two are raw titles and
 *   are flagged for the naming step.
 * Link: HK's own, then the sheet's affiliate link, then the monitor's, then
 *   the plain PokeFinder link.
 * Photo: the last monitor row, then a recent embed, then Target's og:image.
 *
 * Target's page is only fetched when something is still missing, since it is
 * the slowest source and the one most likely to refuse.
 */
export async function resolveDrawItems(lines, {
  sheet = null, lastSeen = async () => null, embeds = new Map(), probe = null,
} = {}) {
  const out = [];
  for (const line of lines) {
    const row = sheet?.get(skuKey(line.tcin)) ?? null;
    const seen = await lastSeen(line.tcin);
    const embed = embeds.get(String(line.tcin)) ?? null;
    const fromSheet = sheetName(row);

    const item = {
      tcin: String(line.tcin), pid: String(line.tcin),
      postName: null, productName: null, rawTitle: null, set: null,
      link: null, affiliate: false, image: null, classification: 'pokemon',
      sources: {}, needsNaming: false,
    };

    if (line.name) {
      Object.assign(item, { postName: line.name, set: fromSheet.set ?? seen?.set_name ?? null });
      item.sources.name = 'yours';
    } else if (fromSheet.name) {
      Object.assign(item, { postName: fromSheet.name, set: fromSheet.set });
      item.sources.name = 'sheet';
    } else if (seen?.product_name) {
      Object.assign(item, { postName: seen.product_name, set: seen.set_name ?? null });
      item.sources.name = 'monitor';
    }

    if (line.link) {
      Object.assign(item, { link: line.link, affiliate: true });
      item.sources.link = 'yours';
    } else if (row?.affiliate) {
      Object.assign(item, { link: row.affiliate, affiliate: true });
      item.sources.link = 'sheet';
    } else if (seen?.affiliate && goodAffiliate(seen.link)) {
      Object.assign(item, { link: seen.link, affiliate: true });
      item.sources.link = 'monitor';
    } else if (embed?.link) {
      const r = raffleLink(embed.link, item.tcin);
      Object.assign(item, r);
      item.sources.link = r.affiliate ? 'monitor' : 'plain';
    } else {
      Object.assign(item, { link: targetUrl(item.tcin), affiliate: false });
      item.sources.link = 'plain';
    }

    item.image = seen?.image_url ?? embed?.image ?? null;
    if (item.image) item.sources.image = seen?.image_url ? 'monitor' : 'embed';

    let title = seen?.raw_title ?? embed?.rawTitle ?? null;
    if ((!item.postName || !item.image) && probe) {
      const p = await probe(item.tcin);
      if (!item.image && p?.image) { item.image = p.image; item.sources.image = 'target.com'; }
      title = title ?? p?.title ?? null;
    }
    if (!item.postName && title) {
      item.rawTitle = title;
      item.needsNaming = true;
      item.sources.name = 'needs naming';
    }

    item.rawTitle = item.rawTitle ?? title ?? item.postName;
    item.productName = item.postName;
    // He named it, so it posts. Only the shape matters for ordering here.
    const c = classify(item.rawTitle ?? '');
    item.classification = c === 'excluded' || !c ? 'pokemon' : c;
    out.push(item);
  }
  return out;
}

/** The items the bot could not name or find at all, which stop the command. */
export const unresolved = (items) => items.filter((i) => !i.postName && !i.needsNaming);

/** One line per item for the preview and the confirmation. */
export function describeItems(items) {
  return items.map((i) => {
    const bits = [
      `name ${i.sources.name ?? 'none'}`,
      `link ${i.sources.link}${i.affiliate ? '' : ' (no affiliate link)'}`,
      `photo ${i.sources.image ?? 'none'}`,
    ];
    return `• **${i.postName ?? i.rawTitle ?? i.tcin}** \`${i.tcin}\` (${bits.join(', ')})`;
  }).join('\n');
}
