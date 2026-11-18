/**
 * The BestBuy in store digest, posted to #instore-alerts at 7AM.
 *
 * Wording is HK's. The only thing this module decides is the order of the
 * products and what to drop if the message will not fit in a Discord post.
 */
import { shortenQueueName } from './queue-copy.js';
import { joinEnglish, orderedPokemon } from './copy.js';
import { DateTime } from 'luxon';
import { classifyQueue, GROUP_ORDER, GROUP_LABEL } from './queue.js';
import { stripGroupName } from './queue-copy.js';

export const DISCORD_LIMIT = 2000;

/** Strip the BestBuy specific furniture, then reuse the queue shortener. */
export function shortTitle(raw) {
  let t = String(raw ?? '');
  t = t.replace(/^Pok[eé]mon\s*[-–—]\s*Trading Card Game:?\s*/i, '');
  t = t.replace(/\bScarlet\s*&\s*Violet\s*[-–—]?\s*/i, '');
  t = t.replace(/\bMega\s*Evolution\s*[-–—]\s*/gi, '');
  // BestBuy appends the per order cap to the title itself, in as many
  // wordings as there are product types. The cap is already stated in the
  // post, so none of them belong in a product name.
  t = t.replace(/\s*\(\s*1\s+[^)]{0,48}?per Order\s*\)\s*/gi, ' ');
  // The hyphenated spelling is BestBuy's; the shortener only knows the spaced
  // one, so without this "Ultra-Premium Collection" never becomes UPC.
  t = t.replace(/\bUltra[-–—]Premium\b/gi, 'Ultra Premium');
  // Their own typo, carried in the Figure Collection titles.
  t = t.replace(/\bMewto\b/g, 'Mewtwo');
  t = t.replace(/\s*[-–—]\s*Styles May Vary\s*$/i, '');
  // BestBuy writes variant bundles as "Sylveon ex Box or Greninja ex Box".
  // A slash reads better in a post than the word.
  t = t.replace(/\s+or\s+/gi, ' / ');
  return shortenQueueName(t);
}

const units = (n) => n.toLocaleString('en-US');

/** "Midwest 1,160 | West 883 | Northeast 839" */
export const regionLine = (regions) =>
  Object.entries(regions).map(([r, n]) => `${r} ${units(n)}`).join(' | ');

/** One bullet per product: name, price, units, states. */
function productLine(i) {
  const price = i.priceDisplay ? ` ${i.priceDisplay}` : '';
  return `• **${i.name}**${price}, ${units(i.units)} units across `
    + `${i.states} ${i.states === 1 ? 'state' : 'states'}`;
}

/** The fallback when the full list will not fit: name and price only. */
const shortLine = (i) => `• **${i.name}**${i.priceDisplay ? ` ${i.priceDisplay}` : ''}`;

/**
 * The digest.
 *
 * `role` and `checkerChannel` are the mention strings. Discord only pings
 * when it is given <@&id>, and only renders a channel link from <#id>.
 *
 * `date` is the morning it posts, shown in the title so one day's post is
 * not mistaken for another's further up the channel.
 *
 * Ordering, as HK set it: Pokemon leads, unheaded. 30th Celebration comes
 * first in it, its products running Ultra or Super Premium, Booster Box,
 * Elite Trainer Box, Booster Bundle, blister; the rest of Pokemon follows by
 * units, biggest restock first. Every other game follows under its own bold
 * heading (One Piece, Magic: The Gathering, Sports Cards, Other), each by
 * units.
 *
 * `items` may carry `postName` and `set` from `nameItems`, the same naming the
 * draws use. Without them it falls back to the BestBuy title shortener, and
 * 30th Celebration is recognised from the raw title instead.
 */
export const isThirtieth = (i) => /30th\s*celebration/i.test(`${i.set ?? ''} ${i.rawTitle ?? ''}`);

/** "November 18", in Eastern, from a Luxon DateTime, a Date or an ISO string. */
export function digestDate(date) {
  if (!date) return null;
  const dt = DateTime.isDateTime(date) ? date
    : date instanceof Date ? DateTime.fromJSDate(date)
      : DateTime.fromISO(String(date), { zone: 'America/New_York' });
  return dt.isValid ? dt.setZone('America/New_York').toFormat('LLLL d') : null;
}

export function bestbuyDigest({ items, role, checkerChannel, date = null }) {
  const named = items
    .map((i) => {
      const group = classifyQueue(i.rawTitle);
      const name = shortTitle(i.postName || i.rawTitle);
      // productRank reads postName first, so it must be the display name.
      return { ...i, name, postName: name, group, classification: group };
    })
    .filter((i) => i.group !== 'excluded' && !i.merch)
    .sort((a, b) => b.units - a.units);

  // Pokemon first and unheaded, as in every other post: 30th Celebration by
  // product shape, then the rest of Pokemon by stock. `named` is already
  // biggest first, so the filters keep that order.
  const poke = named.filter((i) => i.group === 'pokemon');
  const groups = [{
    label: null,
    items: [...orderedPokemon(poke.filter(isThirtieth)), ...poke.filter((i) => !isThirtieth(i))],
  }];
  // Every other game under its own heading, in the usual game order, each by
  // stock. The heading carries the game, so the lines drop it.
  for (const game of GROUP_ORDER.filter((g) => g !== 'pokemon')) {
    const inGroup = named.filter((i) => i.group === game)
      .map((i) => ({ ...i, name: stripGroupName(i.name, game) || i.name }));
    if (inGroup.length) groups.push({ label: GROUP_LABEL[game], items: inGroup });
  }
  const live = groups.filter((g) => g.items.length);
  const usable = live.flatMap((g) => g.items);
  if (!usable.length) return null;

  const day = digestDate(date);
  const head = day ? `# BestBuy Instore Drops: ${day}` : '# BestBuy Instore Drops';
  const intro = `${role} The following items are dropping at BestBuy locations across the US this week:`;
  const tail = `Be sure to use the BestBuy stock checker in ${checkerChannel} every morning to see when locations by you are restocking!`;

  // The list is the post. Everything the reader acts on is in it, so the
  // opening line no longer repeats every product name before they reach it.
  // `upTo` caps how many products are listed, for the truncated form.
  const build = (line, upTo = usable.length) => {
    let left = upTo;
    const blocks = [];
    for (const g of live) {
      if (left <= 0) break;
      const shown = g.items.slice(0, left);
      left -= shown.length;
      const lines = shown.map(line).join('\n');
      blocks.push(g.label ? `**${g.label}**\n${lines}` : lines);
    }
    const more = usable.length - upTo;
    if (more > 0) blocks.push(`• and ${more} more`);
    return [head, intro, ...blocks, tail].join('\n\n');
  };

  const full = build(productLine);
  if (full.length <= DISCORD_LIMIT) return { text: full, form: 'full', items: usable };

  // Too long for one Discord message. Drop the counts rather than silently
  // cutting products off the bottom: which products dropped matters more.
  const compact = build(shortLine);
  if (compact.length <= DISCORD_LIMIT) return { text: compact, form: 'compact', items: usable };

  // A very large night. Keep as many names as fit, and say how many are left.
  let fit = usable.length - 1;
  while (fit > 0 && build(shortLine, fit).length > DISCORD_LIMIT) fit -= 1;
  return { text: build(shortLine, fit), form: 'truncated', items: usable };
}
