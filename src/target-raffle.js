import { DateTime } from 'luxon';
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
  };
}

/** Raffle items, excluding anything the draw path would not post. */
export function usableRaffleItems(items) {
  return items.filter((i) => i.classification !== 'excluded');
}
