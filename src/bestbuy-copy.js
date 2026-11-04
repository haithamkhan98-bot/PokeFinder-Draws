/**
 * The BestBuy in store digest, posted to #instore-alerts at 7AM.
 *
 * Wording is HK's. The only thing this module decides is the order of the
 * products and what to drop if the message will not fit in a Discord post.
 */
import { shortenQueueName } from './queue-copy.js';
import { joinEnglish, orderedPokemon } from './copy.js';
import { classifyQueue, GROUP_ORDER } from './queue.js';

export const DISCORD_LIMIT = 2000;

/** Strip the BestBuy specific furniture, then reuse the queue shortener. */
export function shortTitle(raw) {
  let t = String(raw ?? '');
  t = t.replace(/^Pok[eé]mon\s*[-–—]\s*Trading Card Game:?\s*/i, '');
  t = t.replace(/\bScarlet\s*&\s*Violet\s*/i, '');
  t = t.replace(/\s*\(\s*1\s*Ex Box per Order\s*\)\s*/i, ' ');
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

/** The full block for one product. */
function productBlock(i) {
  const price = i.priceDisplay ? ` ${i.priceDisplay}` : '';
  return [
    `**${i.name}**${price}`,
    `${units(i.units)} units across ${i.states} ${i.states === 1 ? 'state' : 'states'}`,
    regionLine(i.regions),
  ].join('\n');
}

/** The fallback when the full version will not fit: one line per product. */
function compactBlock(i) {
  const price = i.priceDisplay ? ` ${i.priceDisplay}` : '';
  const lead = Object.entries(i.regions)[0];
  return `**${i.name}**${price} ${units(i.units)} units, ${i.states} states`
    + (lead ? `, mostly ${lead[0]}` : '');
}

/**
 * The digest.
 *
 * `role` and `checkerChannel` are the mention strings. Discord only pings
 * when it is given <@&id>, and only renders a channel link from <#id>.
 *
 * Ordering matches the Walmart draws rather than being its own thing. Pokemon
 * leads, its sets ordered with 30th Celebration first and held together, and
 * inside a set the products run Ultra or Super Premium, Booster Box, Elite
 * Trainer Box, Booster Bundle, blister. Everything else follows in the queue
 * group order, One Piece then Magic then sports. Biggest restock breaks every
 * remaining tie, which is what `orderedPokemon` falls back to because the list
 * handed to it is already sorted by units.
 *
 * `items` may carry `postName` and `set` from `nameItems`, the same naming the
 * draws use. Without them it falls back to the BestBuy title shortener, and
 * the set grouping simply has nothing to group on.
 */
export function bestbuyDigest({ items, role, checkerChannel }) {
  const groupRank = (g) => {
    const idx = GROUP_ORDER.indexOf(g);
    return idx === -1 ? GROUP_ORDER.length : idx;
  };

  const named = items
    .map((i) => {
      const group = classifyQueue(i.rawTitle);
      const name = i.postName || shortTitle(i.rawTitle);
      // productRank reads postName first, so it must be the display name.
      return { ...i, name, postName: name, group, classification: group };
    })
    .filter((i) => i.group !== 'excluded' && !i.merch)
    .sort((a, b) => b.units - a.units);

  const poke = orderedPokemon(named.filter((i) => i.group === 'pokemon'));
  const rest = named
    .filter((i) => i.group !== 'pokemon')
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || b.units - a.units);
  const usable = [...poke, ...rest];

  if (!usable.length) return null;

  const head = '# BestBuy Instore Drops';
  const intro = `${role} ${joinEnglish(usable.map((i) => `**${i.name}**`))} are dropping at BestBuy locations this week!`;
  const tail = `Be sure to use the BestBuy stock checker in ${checkerChannel} every morning to see when locations by you are restocking!`;

  const build = (blocks) => [head, intro, ...blocks, tail].join('\n\n');

  const full = build(usable.map(productBlock));
  if (full.length <= DISCORD_LIMIT) return { text: full, form: 'full', items: usable };

  // Too long for one Discord message. Keep every product but drop to one line
  // each rather than silently cutting products off the bottom.
  const compact = build(usable.map(compactBlock));
  if (compact.length <= DISCORD_LIMIT) return { text: compact, form: 'compact', items: usable };

  // Still too long, which means a very large summary. Drop the per product
  // detail entirely and keep the names and the call to action.
  return { text: build([]), form: 'names only', items: usable };
}
