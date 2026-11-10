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
  TIPS, itemLines, otherHeading, orderedSets, otherLabels,
  joinEnglish, shortDate, timeLabel,
} from './copy.js';
import { stripGroupName, timeLabel as queueTimeLabel, whenPhrase } from './queue-copy.js';
import { raffleHeadline } from './target-copy.js';
import { groupQueue } from './queue.js';

/** Draws go to both subs. Queues go to TCGHub alone, mirroring CollectFinder. */
export const SUBS = {
  pokecollectors: process.env.REDDIT_SUB_POKECOLLECTORS || 'PokeCollectors',
  tcghub: process.env.REDDIT_SUB_TCGHUB || 'TCGHub',
};
export const DRAW_SUBS = [SUBS.pokecollectors, SUBS.tcghub];
export const QUEUE_SUBS = [SUBS.tcghub];

/**
 * Reddit's own affiliate links, so its earnings can be told apart from
 * Discord's and Twitter's. These are Mavely rather than the howl links the
 * other channels use, which is what makes the split readable.
 *
 * Target raffles have no equivalent: Target gives every raffle item its own
 * listing with no catchall page, so those posts carry a link per item.
 */
export const REDDIT_DRAW_LINK = process.env.REDDIT_DRAW_LINK
  || 'https://mavely.app.link/UQX3vHGiX7b';
export const REDDIT_QUEUE_LINK = process.env.REDDIT_QUEUE_LINK
  || 'https://mavely.app.link/KTXWeMHiX7b';

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
      // An hour out, not fifteen minutes. Queue drops are announced the night
      // before and HK is not racing them the way he races a draw, so the
      // reminder matches CollectFinder's hour-before post rather than the
      // draw's tighter window.
      dueAt: et.minus({ hours: 1 }),
      subs: QUEUE_SUBS,
      imageUrl,
      title: trimTitle(`Reminder: Walmart Queue Drops Today at ${etClock(dropAt)} EST | ${headline}`),
      body: body(enter, list, tipsBlock()),
    },
  ];
}

/**
 * The two posts for one Target raffle.
 *
 * Two, not the three the tweets get. A Reddit post stays in the subreddit
 * where people can find it, so the announcement is still doing its job on day
 * two; the morning reminder the tweets carry would be a third submission on
 * the same draw to the same sub, which reads as spam and is the quickest way
 * to lose the subreddit.
 *
 * No tips block. The Walmart tips are about saving a card and re-entering an
 * address on walmart.com, and none of that applies to a Target raffle.
 *
 * Every item carries its own markdown link, because Target has no catchall
 * draw page to put in an Enter Here line. Links rather than bare URLs: Reddit
 * renders them, and matching the plain style the tweets and Discord posts use
 * buys nothing on a platform that does not need it.
 */
export function targetRedditPosts({ items, now, closesAt, imageUrl = null }) {
  if (!closesAt) return [];
  const headline = raffleHeadline(items);
  const noun = items.length > 1 ? 'Draws' : 'Draw';
  const et = closesAt.setZone('America/New_York');
  const deadline = `${et.toFormat('LLLL d')} at ${timeLabel(closesAt)}`;
  // Markdown links rather than a bare URL per line. Reddit renders them, so
  // the list reads as product names instead of a wall of target.com, and the
  // other channels' plain style does not have to carry over here.
  const list = `Item List:\n\n${items
    .map((i) => `* [${i.postName ?? i.productName ?? i.rawTitle}](${i.link})`)
    .join('\n')}`;

  return [
    {
      slot: 'live',
      dueAt: null,
      subs: DRAW_SUBS,
      imageUrl,
      // The title states the deadline rather than that it is live, because a
      // title cannot be edited and "live now" stops being news tomorrow while
      // the deadline stays true for the whole window.
      title: trimTitle(`Target ${headline} ${noun} Are Live, Entries Accepted by ${deadline}`),
      body: body(`Entries accepted until ${deadline}.`, list),
    },
    {
      slot: 'closing',
      dueAt: closesAt.minus({ hours: 1 }),
      subs: DRAW_SUBS,
      imageUrl,
      title: trimTitle(`Reminder: Target ${headline} ${noun} Close Today at ${timeLabel(closesAt)}`),
      body: body(`Entries close at ${timeLabel(closesAt)}, one hour from now.`, list),
    },
  ];
}
