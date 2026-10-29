import { setsLabel } from './copy.js';

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

/**
 * Known sets, longest name first so "Mega Evolution Ascended Heroes" wins over
 * "Mega Evolution". This is the fallback path: it needs no API call and no
 * network, and it is what runs if the model is unreachable or returns
 * something unusable.
 */
export const KNOWN_SETS = [
  '30th Anniversary', '30th Celebration', 'Ascended Heroes', 'Phantasmal Flames',
  'Prismatic Evolutions', 'Destined Rivals', 'Perfect Order', 'Chaos Rising',
  'Pitch Black', 'Black Bolt', 'White Flare', 'Mega Evolution', '151',
].sort((a, b) => b.length - a.length);

const NOISE = [
  /^Pok[eé]mon Trading Card Games?:?/i, /^Pok[eé]mon TCGs?:?/i, /Scarlet\s*&?\s*Violet[-—:]?/i,
  /\bSV\s*\d+(\.\d+)?\b/i, /\b20\d\d\b/,
];

/** Strip retailer and publisher noise from a raw monitor title. */
export function cleanTitle(raw) {
  let t = String(raw || '');
  for (const re of NOISE) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').replace(/^[\s:—-]+|[\s:—-]+$/g, '').trim();
}

/** Best effort set name from a title, or null when none is recognised. */
export function setFromTitle(raw) {
  const t = cleanTitle(raw);
  return KNOWN_SETS.find((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) ?? null;
}

/** The deterministic naming, used as the fallback and as the model's starting point. */
export function nameLocally(items) {
  return items.map((item) => {
    const set = setFromTitle(item.rawTitle) ?? setFromTitle(item.productName);
    const postName = cleanTitle(item.productName || item.rawTitle);
    return { ...item, set, postName };
  });
}

const PROMPT = `You are naming Pokemon TCG products for a social post. For each item you are given the raw retailer title.

Return JSON only, no prose, in this exact shape:
{"items":[{"pid":"...","set":"...","postName":"..."}]}

Rules:
- "set" is the set name alone, for example "Prismatic Evolutions", "30th Anniversary", "Ascended Heroes". Never include the publisher, the word Pokemon, or "Scarlet & Violet".
- "postName" is how the product is written in a post: the set name followed by the product, for example "Prismatic Evolutions Booster Bundle 2-Pack" or "30th Celebration Elite Trainer Box".
- Keep the retailer's own pack counts and variant names, hyphenated the way a person would write them ("2-Pack", "3-Pack Blister").
- Strip "Pokemon Trading Card Game", "Pokemon TCG", "Scarlet & Violet", master set prefixes and years.
- Do not invent products, do not merge items, and return exactly one entry per pid.
- Some items are not Pokemon: One Piece, sports cards, or another card game. For those, set "set" to null and write "postName" as a person would write the product, for example "One Piece OP-11 Booster Box" or "2026 Topps Chrome Baseball Hobby Box".`;

/**
 * Ask Claude for the set names and post names.
 *
 * This is the one part of a draw run that genuinely needs judgement: the same
 * product arrives from the monitor under slightly different titles, and new
 * sets appear that no hardcoded list knows about. Everything else in the run
 * is deterministic.
 *
 * Any failure falls back to the local naming rather than stopping the run. A
 * post with a slightly clumsy product name is recoverable; no post at all is
 * not.
 */
export async function nameItems(items, { timeoutMs = 30_000 } = {}) {
  const local = nameLocally(items);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { items: local, source: 'local', note: 'ANTHROPIC_API_KEY is not set' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: PROMPT,
        messages: [{
          role: 'user',
          content: JSON.stringify(items.map((i) => ({ pid: i.pid, rawTitle: i.rawTitle }))),
        }],
      }),
    });

    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body.content?.map((c) => c.text).join('') ?? '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

    const byPid = new Map(parsed.items.map((i) => [String(i.pid), i]));
    const named = local.map((item) => {
      const got = byPid.get(String(item.pid));
      if (!got?.set || !got?.postName) return item;
      return { ...item, set: got.set, postName: got.postName };
    });

    const missing = named.filter((i) => !i.set);
    return {
      items: named,
      source: 'model',
      note: missing.length ? `${missing.length} item(s) have no set name` : null,
    };
  } catch (err) {
    return { items: local, source: 'local', note: `naming fell back to the local list: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The distinct Pokemon set names, in run order.
 *
 * Only Pokemon items carry a set: One Piece, sports and the other card games
 * are named by category in the headline instead, so including them here would
 * put them in the Pokemon part of the label.
 */
export const setsOf = (items) => [...new Set(
  items.filter((i) => !i.classification || i.classification === 'pokemon')
    .map((i) => i.set).filter(Boolean),
)];

export { setsLabel };

const HEADLINE_PROMPT = `You write the opening line of a PokeFinder tweet announcing a Walmart queue drop.

You are given the products, grouped by game, already in the order they must be named.

Return JSON only: {"headline":"..."}

The headline is the product summary ONLY. Do not write "Going Live", a date, a time, emoji, hashtags or any punctuation at the end. That wording is added around it.

Rules:
- Name the groups in the order given. Pokemon first when present.
- For each group name its standout products, not every product. Two or three names across the whole headline is plenty.
- Write product names the way a collector would: "Magic The Gathering Star Trek Collector Boosters", "30th Celebration Elite Trainer Boxes", "Topps Bowman Football".
- Write "Magic The Gathering" without the colon.
- Where a group has many items and no standout, name the category instead, for example "Sports Cards".
- Join with commas and a final "and".`;

/**
 * The product summary that opens each queue post.
 *
 * This is the one genuinely editorial line in a queue run: which products are
 * worth naming out of a list that can run to a dozen. The fallback names the
 * leading product of each group, which is always defensible even if it reads
 * less naturally than the model's version.
 */
export async function queueHeadline(groups, { timeoutMs = 20_000, fallback: given = null } = {}) {
  const fallback = given || fallbackHeadline(groups);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { headline: fallback, source: 'local', note: 'ANTHROPIC_API_KEY is not set' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: HEADLINE_PROMPT,
        messages: [{
          role: 'user',
          content: JSON.stringify(groups.map((g) => ({
            group: g.label,
            products: g.items.map((i) => i.postName ?? i.productName ?? i.rawTitle),
          }))),
        }],
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body.content?.map((c) => c.text).join('') ?? '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const headline = String(parsed.headline ?? '').trim();
    if (!headline) throw new Error('the model returned an empty headline');
    return { headline, source: 'model', note: null };
  } catch (err) {
    return { headline: fallback, source: 'local', note: `headline fell back to the local wording: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function fallbackHeadline(groups) {
  const parts = groups.map((g) => {
    const lead = g.items[0];
    const name = lead?.postName ?? lead?.productName ?? lead?.rawTitle ?? '';
    if (g.game === 'sports' || !name) return g.label;
    return name;
  });
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
