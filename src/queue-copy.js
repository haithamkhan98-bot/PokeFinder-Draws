import { groupQueue, GROUP_LABEL } from './queue.js';
import { joinEnglish } from './copy.js';

export const QUEUE_LINK = 'https://howl.link/ffngiff7nu8la';

const clock = (dt) => {
  const h = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const suffix = dt.hour < 12 ? 'AM' : 'PM';
  return dt.minute === 0 ? `${h}${suffix}` : `${h}:${dt.toFormat('mm')}${suffix}`;
};

/** "9PM EST / 6PM PST" */
export function timeLabel(dropAt) {
  const et = dropAt.setZone('America/New_York');
  const pt = dropAt.setZone('America/Los_Angeles');
  return `${clock(et)} EST / ${clock(pt)} PST`;
}

/**
 * "Tonight" only when the post actually goes out on the drop day.
 *
 * A post written on Tuesday for a Wednesday drop must name the day, or it
 * reads as though the drop is hours away when it is more than a day off.
 */
export function whenPhrase(dropAt, sentAt) {
  const drop = dropAt.setZone('America/New_York');
  const now = sentAt.setZone('America/New_York');
  if (drop.hasSame(now, 'day')) return 'Tonight';
  if (drop.hasSame(now.plus({ days: 1 }), 'day')) return 'Tomorrow';
  return drop.toFormat('cccc'); // e.g. "Wednesday"
}

/**
 * The grouped product list.
 *
 * Each group gets a heading and its own items beneath, with the group name
 * stripped from the product lines since the heading already carries it.
 */
export function productBlock(items) {
  return groupQueue(items).map((g) => {
    const lines = g.items.map((i) => `• ${stripGroupName(i.postName ?? i.productName, g.game)}`);
    return `${g.label}\n${lines.join('\n')}`;
  }).join('\n\n');
}

const GROUP_PREFIXES = {
  mtg: [/^magic:?\s*the\s*gathering\s*:?\s*/i, /^mtg\s*:?\s*/i],
  onepiece: [/^one\s*piece\s*(card\s*game)?\s*:?\s*/i, /^optcg\s*:?\s*/i],
  pokemon: [/^pok[eé]mon\s*(tcg|trading card game)?\s*:?\s*/i],
  sports: [],
  other: [],
};

export function stripGroupName(name, game) {
  let out = String(name ?? '');
  for (const re of GROUP_PREFIXES[game] ?? []) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** The paste ready list for Discord and for HK's own use. */
export function linkList(items) {
  const blocks = groupQueue(items).map((g) => {
    const lines = g.items.map((i) => {
      const name = stripGroupName(i.postName ?? i.productName, g.game);
      return `${name} ${i.link ?? `https://www.walmart.com/ip/PokeFinder/${i.pid}`}`;
    });
    return `## ${g.label}\n${lines.join('\n')}`;
  });
  return [
    '# Walmart Wednesday Drop List',
    'Here are all the items we are expecting to drop on Walmart at 9PM EST',
    '',
    ...blocks,
  ].join('\n');
}

/**
 * The three CollectFinder posts for one queue drop.
 *
 * `headline` is the product summary that opens each post, for example
 * "Magic The Gathering Star Trek Collector Boosters, Pokemon 30th Celebration
 * Elite Trainer Boxes and Sports Cards". The rest of the wording is fixed.
 */
export function buildQueuePosts({ items, dropAt, headline, now }) {
  const when = timeLabel(dropAt);
  const list = productBlock(items);
  const link = `Queue Link: ${QUEUE_LINK}`;
  const et = dropAt.setZone('America/New_York');

  const body = (title) => [title, link, list, '#Pokemon #ad'].join('\n\n');

  return [
    {
      slot: 'announcement',
      dueAt: null,
      text: body(
        `💫 ${headline} Going Live on Walmart ${whenPhrase(dropAt, now)} at ${when}!`,
      ),
    },
    {
      // A quarter of an hour out, matching the draws' own minutes-out reminder
      // wording. There is no 9AM post: a queue drop is announced the night
      // before and reminded twice on the night, not through the day.
      slot: 'fifteen_minutes',
      dueAt: et.minus({ minutes: 15 }),
      text: body(`💫 Reminder: ${headline} Going Live on Walmart in 15 Minutes!`),
    },
    {
      // One minute before the drop, matching the draw framework.
      slot: 'going_live',
      dueAt: et.minus({ minutes: 1 }),
      text: body(`💫 ${headline} Going Live on Walmart Now!`),
    },
  ];
}

export { GROUP_LABEL };

/**
 * The draw's closing tweet when a queue drop follows on the same day.
 *
 * Draws and queue drops both land on Wednesdays, so the 6PM "draw is over"
 * post is the natural place to hand the audience straight on to the 9PM queue.
 * It ends at #Pokemon #ad rather than plain #Pokemon because, unlike the
 * ordinary closing post, this one carries a link.
 */
export function drawOverWithQueue({ items, dropAt }) {
  return [
    `💫 Today's Walmart Draw is Now Over! Next we have a Walmart Queue drop at ${timeLabel(dropAt)}!`,
    `Queue Link: ${QUEUE_LINK}`,
    productBlock(items),
    '#Pokemon #ad',
  ].join('\n\n');
}

/**
 * The late queue draft.
 *
 * Saved as a draft rather than published, because these arrive minutes before
 * the drop and HK wants eyes on them first. Each product carries its own link
 * on the same line, which is the standing format for Walmart posts, and is why
 * this one keeps the #ad tag.
 */
/**
 * Walmart sells the queue itself; a marketplace seller sells its own stock on
 * the same page. "Walmart.com", and a missing seller, are first party.
 */
export const isFirstPartySeller = (seller) => !seller || /walmart/i.test(seller);

/**
 * First party items first, then one section per marketplace seller, each in
 * the order its highest priority item earned. Within a section the normal
 * game priority still applies, so Pokemon leads wherever a seller has any.
 */
export function sellerSections(items) {
  const ordered = groupQueue(items).flatMap((g) => g.items);
  const sections = [{ seller: null, items: [] }];
  for (const i of ordered) {
    if (isFirstPartySeller(i.seller)) { sections[0].items.push(i); continue; }
    const key = i.seller.trim();
    let section = sections.find((s) => s.seller === key);
    if (!section) { section = { seller: key, items: [] }; sections.push(section); }
    section.items.push(i);
  }
  return sections.filter((s) => s.items.length);
}

/**
 * The sports card lines, longest name first so "Topps Chrome Sapphire" wins
 * over "Topps Chrome" and "Panini Donruss Optic" over "Panini".
 *
 * A sports item is summarised by its line, not by the word "Sports Cards":
 * "Topps Chrome" tells a collector what is dropping and the category does not.
 */
export const SPORTS_LINES = [
  'Topps Chrome Sapphire', 'Topps Chrome', 'Topps Finest', 'Topps Heritage',
  'Topps Bowman', 'Bowman Chrome', 'Bowman Sapphire', 'Bowman', 'Topps',
  'Panini Donruss Optic', 'Panini Donruss', 'Panini Prizm', 'Panini Select',
  'Panini Mosaic', 'Panini Obsidian', 'Panini', 'Leaf',
].sort((a, b) => b.length - a.length);

export const sportsLine = (title) => SPORTS_LINES.find(
  (b) => new RegExp(`\\b${b}\\b`, 'i').test(String(title ?? '')),
) ?? null;

/** How each non Pokemon group is named in the summary line. */
const SUMMARY_LABEL = { mtg: 'Magic The Gathering', onepiece: 'One Piece', other: 'Other TCG' };

/**
 * The summary line that follows the title.
 *
 * Pokemon is named by set alone, every other card game by the game's name, and
 * sports cards by their line. Groups keep the order the product lists use, so
 * the summary and the lists never disagree about what leads.
 */
export function queueSummary(items) {
  const names = [];
  for (const g of groupQueue(items)) {
    if (g.game === 'pokemon') {
      // A set the naming step could not place leaves the item with no set. The
      // category is the honest minimum: better a summary that says Pokemon
      // than one that leaves the headline act out altogether.
      for (const i of g.items) names.push(i.set || 'Pokemon');
      continue;
    }
    if (g.game === 'sports') {
      for (const i of g.items) {
        const line = sportsLine(i.postName ?? i.productName ?? i.rawTitle);
        names.push(line ?? 'Sports Cards');
      }
      continue;
    }
    names.push(SUMMARY_LABEL[g.game]);
  }
  return joinEnglish([...new Set(names)]);
}

/**
 * Queue product names, slightly shortened.
 *
 * Queue titles run much longer than draw titles, and a drop of ten of them
 * does not fit a tweet written out in full. Only filler and the two
 * abbreviations HK already uses come out; nothing that identifies the product
 * does, so each line still reads as its own product.
 */
const SHORTEN = [
  [/\bPok[eé]mon\s+Trading\s+Card\s+Games?\b/gi, ''],
  [/\bPok[eé]mon\s+TCG\b/gi, ''],
  [/\bTrading\s+Card\s+Games?\b/gi, ''],
  [/\bTrading\s+Cards?\b/gi, ''],
  [/\bCollectible\s+Card\s+Game\b/gi, ''],
  [/^\s*Sports\s+Cards\s+/i, ''],
  [/\bMagic:?\s+The\s+Gathering\b/gi, 'MTG'],
  [/\bOne\s+Piece\s+Card\s+Game\b/gi, 'One Piece'],
  [/\bElite\s+Trainer\s+Box(es)?\b/gi, 'ETB$1'],
  [/\bUltra\s+Premium\s+Collection\b/gi, 'UPC'],
];

export function shortenQueueName(name) {
  let t = String(name ?? '');
  for (const [re, to] of SHORTEN) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').replace(/^[\s:-]+|[\s:-]+$/g, '').trim();
}

export function potentialQueuePost({ items, dropAt }) {
  // The game name is NOT stripped here. Stripping is only right when a group
  // heading carries it, and these lists are flat: "Star Trek Collector Booster"
  // on its own gives no clue that it is Magic. The seller heading says who is
  // selling, not what the product is, so it strips nothing either.
  const line = (i) => {
    const name = shortenQueueName(i.postName ?? i.productName);
    return `${name} ${i.link ?? `https://www.walmart.com/ip/PokeFinder/${i.pid}`}`;
  };

  const blocks = sellerSections(items).map((s) => {
    const list = s.items.map(line).join('\n');
    return s.seller ? `${s.seller}\n${list}` : list;
  });

  return [
    `💫 Walmart Queue Going Live at ${timeLabel(dropAt)}! ${queueSummary(items)}!`,
    ...blocks,
    '#Pokemon #ad',
  ].join('\n\n');
}
