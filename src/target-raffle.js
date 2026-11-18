import { DateTime } from 'luxon';

const ET = 'America/New_York';
const ZONES = {
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  et: ET, est: ET, edt: ET,
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
};

/**
 * The embed's Drawing Date field, as an instant.
 *
 * Read as a Discord timestamp (`<t:1795104000:f>`) when it is one, which is
 * exact. A written out date ("November 19, 2026 11:00 AM", plain or in inline
 * code) is read as Eastern unless it names a zone: on the Nov 19 draw that
 * matches the 11AM Eastern close Target stated.
 *
 * This replaces the bookmarklet as the source of the close time: the
 * bookmarklet stays only as a fallback for an embed that arrives without one.
 */
export function readDrawingDate(value) {
  // Inline code and bold render with the same shaded box a timestamp does,
  // so the markup is stripped before anything is read.
  const v = String(value ?? '').replace(/[`*_]/g, '').trim();
  if (!v) return null;
  const stamp = v.match(/<t:(\d{9,11})(?::[a-zA-Z])?>/);
  if (stamp) return DateTime.fromSeconds(Number(stamp[1])).setZone(ET);
  if (/^\d{13}$/.test(v)) return DateTime.fromMillis(Number(v)).setZone(ET);
  if (/^\d{10}$/.test(v)) return DateTime.fromSeconds(Number(v)).setZone(ET);

  const zoneM = v.match(/\b(ct|cst|cdt|et|est|edt|mt|mst|mdt|pt|pst|pdt)\b/i);
  const zone = zoneM ? ZONES[zoneM[1].toLowerCase()] : ET;
  const bare = v.replace(/\b(ct|cst|cdt|et|est|edt|mt|mst|mdt|pt|pst|pdt)\b/i, '').replace(/\s+/g, ' ').trim();
  for (const f of ['LLLL d, yyyy h:mm a', 'LLL d, yyyy h:mm a', 'LLLL d, yyyy h a', 'M/d/yyyy h:mm a', 'M/d/yyyy, h:mm a']) {
    const dt = DateTime.fromFormat(bare, f, { zone, locale: 'en-US' });
    if (dt.isValid) return dt.setZone(ET);
  }
  return null;
}
import { classify, suggestName, isBlockedLink } from './parse.js';
import { targetUrl } from './target.js';

export const TARGET_AUTHOR = 'Target Raffles';

const field = (embed, name) => (embed?.fields ?? [])
  .find((f) => new RegExp(`^\\s*${name}\\s*$`, 'i').test(f?.name ?? ''))?.value ?? null;

/**
 * Tell a raffle from an ordinary restock.
 *
 * The Target Raffles monitor posts both. The only reliable difference is a
 * Raffle Status field, which restock embeds do not carry at all. The Type
 * field is NOT the discriminator: it reads "Restock" on raffle embeds too,
 * so keying on it would post every restock as a draw.
 */
export function isRaffleEmbed(embed) {
  if ((embed?.author?.name ?? '').trim() !== TARGET_AUTHOR) return false;
  return (embed?.fields ?? []).some((f) => /raffle\s*status/i.test(f?.name ?? ''));
}

/**
 * Which link to publish.
 *
 * HK sets the affiliate links on the monitor by hand, so some embeds arrive
 * with somebody else's link and some with none. Zephyr's links earn Zephyr,
 * not us, and a bare target.com URL is not in HK's normalised form. Both fall
 * back to the plain PokeFinder link, which at least points at the right item.
 */
export function raffleLink(url, tcin) {
  const u = String(url ?? '').trim();
  if (!u) return { link: targetUrl(tcin), affiliate: false };
  if (isBlockedLink(u)) return { link: targetUrl(tcin), affiliate: false };
  try {
    if (/(^|\.)target\.com$/i.test(new URL(u).hostname)) {
      return { link: targetUrl(tcin), affiliate: false };
    }
  } catch {
    return { link: targetUrl(tcin), affiliate: false };
  }
  return { link: u, affiliate: true };
}

/**
 * One Target Raffles embed into an item.
 *
 * Unlike Walmart there is no time to parse: a Target draw is already open when
 * the embed fires, so detection IS the start. Price is usually "N/A USD",
 * which is why these rank on set priority rather than price.
 */
export function parseTargetRaffle(embed, { now = DateTime.now() } = {}) {
  if (!isRaffleEmbed(embed)) return null;

  const tcin = String(field(embed, 'Tcin') ?? '').trim();
  const rawTitle = String(embed?.title ?? '').trim();
  if (!tcin || !rawTitle) return null;

  const { link, affiliate } = raffleLink(embed?.url, tcin);
  const name = suggestName(rawTitle);
  const closesAt = readDrawingDate(field(embed, 'Drawing Date') ?? field(embed, 'Drawing Ends') ?? field(embed, 'Draw Date'));
  const classification = classify(rawTitle);

  return {
    pid: tcin,
    tcin,
    rawTitle,
    productName: name,
    postName: name,
    set: null,
    classification,
    link,
    affiliate,
    image: embed?.thumbnail?.url ?? null,
    priceDisplay: null,
    openedAt: now,
    closesAt,
    // "Drawing Open" today. Kept so a closing notice is never taken for a
    // new draw (see isClosedNotice).
    type: String(field(embed, 'Type') ?? '').trim() || null,
  };
}

/**
 * What any Target monitor embed says about its listing, raffle or not.
 *
 * For `!targetdraw`, which wants a title, a photo and HK's monitor link for an
 * item he names. A restock embed for the same TCIN carries all three just as
 * well as a raffle one does.
 */
export function embedListing(embed) {
  if ((embed?.author?.name ?? '').trim() !== TARGET_AUTHOR) return null;
  const tcin = String(field(embed, 'Tcin') ?? '').trim();
  if (!tcin) return null;
  return {
    tcin,
    rawTitle: String(embed?.title ?? '').trim() || null,
    link: embed?.url ?? null,
    image: embed?.thumbnail?.url ?? embed?.image?.url ?? null,
    closesAt: readDrawingDate(field(embed, 'Drawing Date')),
  };
}

/**
 * The monitor's Type reads "Drawing Open" on a new draw. A notice that one has
 * closed or ended must not be announced as a new draw.
 */
export const isClosedNotice = (item) => /\b(closed|ended|over)\b/i.test(item?.type ?? '');

/** Raffle items, excluding anything the draw path would not post. */
export function usableRaffleItems(items, { now = DateTime.now() } = {}) {
  return items.filter((i) => i.classification !== 'excluded'
    && !isClosedNotice(i)
    // A drawing date already past is a draw nobody can enter.
    && !(i.closesAt && i.closesAt <= now));
}
