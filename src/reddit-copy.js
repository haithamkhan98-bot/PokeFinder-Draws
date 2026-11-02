/**
 * Reddit post copy.
 *
 * Deliberately leaner than the tweets. A title, the Canva image, one line
 * saying where and when to enter, and the item list. The going live post adds
 * the tips block; the announcement does not.
 *
 * Two Reddit constraints shape this:
 *  1. Titles cannot be edited after posting, so no title counts down. The go
 *     live post says "Go Live Today at 5PM EST", which is still true at 5:30.
 *  2. Emoji and hashtags read as spam, so the tweet furniture comes off. The
 *     words inside the item lines and the tips are HK's, reused from copy.js
 *     unchanged; only the bullet character becomes a markdown list marker.
 */
import {
  TIPS, DRAW_LINK_DISCORD, itemLines, otherHeading, orderedSets, otherLabels,
  joinEnglish, shortDate, timeLabel,
} from './copy.js';
import { QUEUE_LINK, stripGroupName, timeLabel as queueTimeLabel, whenPhrase } from './queue-copy.js';
import { groupQueue } from './queue.js';

/** Draws go to both subs. Queues go to TCGHub alone, mirroring CollectFinder. */
export const SUBS = {
  pokecollectors: process.env.REDDIT_SUB_POKECOLLECTORS || 'PokeCollectors',
  tcghub: process.env.REDDIT_SUB_TCGHUB || 'TCGHub',
};
export const DRAW_SUBS = [SUBS.pokecollectors, SUBS.tcghub];
export const QUEUE_SUBS = [SUBS.tcghub];

/**
 * Reddit gets its own affiliate links so its earnings can be told apart from
 * Discord's and Twitter's. Until those are set, fall back to the existing
 * links rather than post a dead one.
 */
export const REDDIT_DRAW_LINK = process.env.REDDIT_DRAW_LINK || DRAW_LINK_DISCORD;
export const REDDIT_QUEUE_LINK = process.env.REDDIT_QUEUE_LINK || QUEUE_LINK;

export const TITLE_MAX = 300;

export function trimTitle(title) {
  if (title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX);
  return cut.slice(0, cut.lastIndexOf(' ')).trimEnd();
}

/** "• Thing $9.99" -> "* Thing $9.99". The line itself is untouched. */
const bullets = (block) => block.split('\n').map((l) => l.replace(/^•\s*/, '* ')).join('\n');

/** The tips block, going live posts only. */
export function tipsBlock() {
  const [head, ...rest] = TIPS.split('\n');
  return `**${head.replace(/:\s*$/, '')}**\n\n${bullets(rest.join('\n'))}`;
}

const isPokemon = (i) => i.classification === 'pokemon' || !i.classification;

/** Pokemon first and unlabelled, then the other games under their heading. */
export function drawItems(items) {
  const poke = items.filter(isPokemon);
  const others = items.filter((i) => !isPokemon(i));
  const blocks = [];
  if (poke.length) blocks.push(bullets(itemLines(poke)));
  if (others.length) blocks.push(`**${otherHeading(others)}**\n\n${bullets(itemLines(others))}`);
  return blocks.join('\n\n');
}

/** The queue list, one bolded heading per game. */
export function queueItems(items) {
  return groupQueue(items).map((g) => {
    const lines = g.items.map((i) => `* ${stripGroupName(i.postName ?? i.productName, g.game)}`);
    return `**${g.label}**\n\n${lines.join('\n')}`;
  }).join('\n\n');
}

const etClock = (dt) => {
  const et = dt.setZone('America/New_York');
  const h = et.hour % 12 === 0 ? 12 : et.hour % 12;
  const suffix = et.hour < 12 ? 'AM' : 'PM';
  return et.minute === 0 ? `${h}${suffix}` : `${h}:${et.toFormat('mm')}${suffix}`;
};

/** "Monday 11/3", or "Today" / "Tomorrow" when it is close enough to say so. */
function dayPhrase(at, now) {
  const day = at.setZone('America/New_York');
  const today = now.setZone('America/New_York');
  if (day.hasSame(today, 'day')) return 'Today';
  if (day.hasSame(today.plus({ days: 1 }), 'day')) return 'Tomorrow';
  return `${day.toFormat('cccc')} ${shortDate(at)}`;
}

const body = (...blocks) => blocks.filter(Boolean).join('\n\n');

/** "Enter Here at 5PM EST / 2PM PST: [Walmart Collectibles Draw](...)" */
const enterLine = (when, label, link) => `Enter Here at ${when}: [${label}](${link})`;

/** The two posts for one draw day. `imageUrl` is the Canva grid. */
export function drawRedditPosts({ items, sets, startsAt, endsAt, now, imageUrl = null }) {
  const label = joinEnglish([...orderedSets(sets), ...otherLabels(items)]);
  const noun = (sets.length || 0) + otherLabels(items).length > 1 ? 'Draws' : 'Draw';
  const when = timeLabel(startsAt);
  const list = `Item List:\n\n${drawItems(items)}`;
  const enter = enterLine(when, 'Walmart Collectibles Draw', REDDIT_DRAW_LINK);
  const et = startsAt.setZone('America/New_York');

  return [
    {
      slot: 'announcement',
      dueAt: null,
      subs: DRAW_SUBS,
      imageUrl,
      title: trimTitle(`Walmart ${label} ${noun} ${dayPhrase(startsAt, now)} at ${etClock(startsAt)} EST`),
      body: body(enter, list),
    },
    {
      slot: 'going_live',
      dueAt: et.minus({ minutes: 15 }),
      subs: DRAW_SUBS,
      imageUrl,
      title: trimTitle(`Reminder: Walmart ${label} ${noun} Go Live Today at ${etClock(startsAt)} EST`),
      body: body(enter, list, tipsBlock()),
    },
  ];
}

/** The two posts for one queue drop. `imageUrl` is the composited grid. */
export function queueRedditPosts({ items, dropAt, headline, now, imageUrl = null }) {
  const when = queueTimeLabel(dropAt);
  const list = `Item List:\n\n${queueItems(items)}`;
  const enter = enterLine(when, 'Walmart Collectibles Queue', REDDIT_QUEUE_LINK);
  const et = dropAt.setZone('America/New_York');

  return [
    {
      slot: 'announcement',
      dueAt: null,
      subs: QUEUE_SUBS,
      imageUrl,
      title: trimTitle(`Walmart Queue Drop ${whenPhrase(dropAt, now)} at ${etClock(dropAt)} EST | ${headline}`),
      body: body(enter, list),
    },
    {
      slot: 'going_live',
      dueAt: et.minus({ minutes: 15 }),
      subs: QUEUE_SUBS,
      imageUrl,
      title: trimTitle(`Reminder: Walmart Queue Drops Today at ${etClock(dropAt)} EST | ${headline}`),
      body: body(enter, list, tipsBlock()),
    },
  ];
}
