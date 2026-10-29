import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  parseQueueEmbed, nextDropAt, classifyQueue, groupQueue, sortGroup, orderedQueueItems,
} from '../src/queue.js';
import { whenPhrase, productBlock, linkList, buildQueuePosts, timeLabel } from '../src/queue-copy.js';

const et = (iso) => DateTime.fromISO(iso, { zone: 'America/New_York' });

// The real Droplist embed, as the monitor posts it.
const queueEmbed = {
  author: { name: 'Walmart Droplist' },
  title: '2026 Topps Bowman Football Trading Cards Value Box',
  thumbnail: { url: 'https://i5.walmartimages.com/asr/example.jpeg' },
  fields: [
    { name: 'Price', value: '$29.97' },
    { name: 'Type', value: 'New Product' },
    { name: 'PID', value: '20943802675' },
    { name: 'Cart Limit', value: '3' },
    { name: 'Seller', value: 'Walmart.com' },
    { name: 'Note', value: 'This product is not live yet, this monitor tracks products that are getting ready for release.' },
  ],
};

test('a Droplist embed parses into a queue item', () => {
  const item = parseQueueEmbed(queueEmbed, { now: et('2026-10-27T20:25') });
  assert.equal(item.pid, '20943802675');
  assert.equal(item.priceDisplay, '$29.97');
  assert.equal(item.priceCents, 2997);
  assert.equal(item.cartLimit, '3');
  assert.equal(item.classification, 'sports');
  assert.equal(item.dropDate, '2026-10-28');
});

test('a draw embed is not treated as a queue item', () => {
  assert.equal(parseQueueEmbed({ ...queueEmbed, author: { name: 'Walmart Draws' } }), null);
  assert.equal(parseQueueEmbed({ ...queueEmbed, author: { name: 'Walmart US V2' } }), null);
});

test('an unreadable queue embed reports what is missing', () => {
  const broken = { ...queueEmbed, fields: [{ name: 'Type', value: 'New Product' }] };
  const res = parseQueueEmbed(broken, { now: et('2026-10-27T20:25') });
  assert.match(res.error, /missing PID, Price/);
});

// Queue embeds carry no date, so the drop is inferred. Getting this wrong
// schedules a whole post set on the wrong day.
test('the drop is the next Wednesday 9PM that has not passed', () => {
  // Tuesday evening: the drop is tomorrow.
  assert.equal(nextDropAt(et('2026-10-27T20:25')).toISO(), et('2026-10-28T21:00').toISO());
  // Wednesday before 9PM: the drop is tonight.
  assert.equal(nextDropAt(et('2026-10-28T20:25')).toISO(), et('2026-10-28T21:00').toISO());
  // Wednesday after the drop: roll on a week.
  assert.equal(nextDropAt(et('2026-10-28T22:00')).toISO(), et('2026-11-04T21:00').toISO());
  // Thursday: still next week.
  assert.equal(nextDropAt(et('2026-10-29T09:00')).toISO(), et('2026-11-04T21:00').toISO());
});

test('Upper Deck and College products are excluded entirely', () => {
  assert.equal(classifyQueue('2026 Upper Deck Series 1 Hockey Blaster'), 'excluded');
  assert.equal(classifyQueue('2026 Bowman University College Football Box'), 'excluded');
});

test('products are sorted into their games', () => {
  assert.equal(classifyQueue('Pokemon TCG: 30th Celebration Elite Trainer Box'), 'pokemon');
  assert.equal(classifyQueue('Magic: The Gathering Star Trek Collector Booster'), 'mtg');
  assert.equal(classifyQueue('One Piece Card Game OP-11 Booster Box'), 'onepiece');
  assert.equal(classifyQueue('2026 Topps Bowman Football Trading Cards Value Box'), 'sports');
  assert.equal(classifyQueue('Some Unknown Trading Card Thing'), 'other');
});

const item = (title, cents, game) => ({
  rawTitle: title, productName: title, postName: title,
  priceCents: cents, priceDisplay: `$${(cents / 100).toFixed(2)}`,
  classification: game, pid: String(cents),
});

test('Magic leads with Collector products, then price descending', () => {
  const sorted = sortGroup('mtg', [
    item('Magic: The Gathering Star Trek Play Booster', 2999, 'mtg'),
    item('Magic: The Gathering Star Trek Collector Booster', 2499, 'mtg'),
    item('Magic: The Gathering Star Trek Bundle', 4999, 'mtg'),
  ]);
  assert.match(sorted[0].rawTitle, /Collector/);
  assert.match(sorted[1].rawTitle, /Bundle/);
});

test('sports cards lead with Topps, and Bowman or Chrome inside that', () => {
  const sorted = sortGroup('sports', [
    item('2026 Panini Prizm Basketball Mega Box', 5999, 'sports'),
    item('2026 Topps Series 2 Baseball Value Box', 1999, 'sports'),
    item('2026 Topps Bowman Chrome Football Hobby Box', 2997, 'sports'),
  ]);
  assert.match(sorted[0].rawTitle, /Bowman Chrome/);
  assert.match(sorted[1].rawTitle, /Topps Series 2/);
  assert.match(sorted[2].rawTitle, /Panini/);
});

test('everything else is simply most expensive first', () => {
  const sorted = sortGroup('pokemon', [item('A', 1000, 'pokemon'), item('B', 9000, 'pokemon')]);
  assert.deepEqual(sorted.map((i) => i.rawTitle), ['B', 'A']);
});

test('groups run Pokemon, One Piece, Magic, Sports, Other', () => {
  const groups = groupQueue([
    item('2026 Topps Bowman Football Value Box', 2997, 'sports'),
    item('Mystery Game Booster', 1000, 'other'),
    item('Pokemon TCG 30th Celebration ETB', 5999, 'pokemon'),
    item('One Piece OP-11 Booster Box', 9588, 'onepiece'),
    item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg'),
  ]);
  assert.deepEqual(groups.map((g) => g.game), ['pokemon', 'onepiece', 'mtg', 'sports', 'other']);
  assert.equal(orderedQueueItems.length, 1); // function arity, guards against a signature change
});

test('the group name is dropped from the product lines beneath its heading', () => {
  const text = productBlock([
    item('Magic: The Gathering Star Trek Bundle', 4999, 'mtg'),
    item('One Piece Card Game OP-11 Booster Box', 9588, 'onepiece'),
  ]);
  assert.ok(text.includes('Magic: The Gathering\n• Star Trek Bundle'));
  assert.ok(text.includes('One Piece\n• OP-11 Booster Box'));
});

// "Tonight" on a post that goes out the day before reads as though the drop is
// hours away when it is more than a day off.
test('Tonight is only used on the drop day itself', () => {
  const drop = et('2026-10-28T21:00');
  assert.equal(whenPhrase(drop, et('2026-10-28T08:00')), 'Tonight');
  assert.equal(whenPhrase(drop, et('2026-10-27T20:30')), 'Tomorrow');
  assert.equal(whenPhrase(drop, et('2026-10-25T12:00')), 'Wednesday');
});

test('the queue posts carry the link once and end at the ad tag', () => {
  const posts = buildQueuePosts({
    items: [item('Pokemon TCG 30th Celebration ETB', 5999, 'pokemon')],
    dropAt: et('2026-10-28T21:00'),
    headline: 'Pokemon 30th Celebration Elite Trainer Boxes',
    now: et('2026-10-27T20:30'),
  });
  assert.deepEqual(posts.map((p) => p.slot), ['announcement', 'morning', 'going_live']);
  for (const p of posts) {
    assert.equal((p.text.match(/howl\.link\/ffngiff7nu8la/g) || []).length, 1);
    assert.ok(p.text.endsWith('#Pokemon #ad'));
  }
  assert.match(posts[0].text, /Going Live on Walmart Tomorrow at 9PM EST \/ 6PM PST!/);
});

test('queue posts are anchored to the drop, not to when they were written', () => {
  const posts = buildQueuePosts({
    items: [item('Pokemon TCG 30th Celebration ETB', 5999, 'pokemon')],
    dropAt: et('2026-10-28T21:00'),
    headline: 'Pokemon',
    now: et('2026-10-27T20:30'),
  });
  const at = (slot) => posts.find((p) => p.slot === slot).dueAt.setZone('America/New_York').toFormat('ccc HH:mm');
  assert.equal(at('morning'), 'Wed 09:00');
  assert.equal(at('going_live'), 'Wed 20:59');
});

test('the drop time is written the way the posts write it', () => {
  assert.equal(timeLabel(et('2026-10-28T21:00')), '9PM EST / 6PM PST');
});

test('the link list uses the standing heading and groups the items', () => {
  const text = linkList([
    item('Pokemon TCG 30th Celebration ETB', 5999, 'pokemon'),
    item('2026 Topps Bowman Football Value Box', 2997, 'sports'),
  ]);
  assert.ok(text.startsWith('# Walmart Wednesday Drop List'));
  assert.ok(text.includes('Here are all the items we are expecting to drop on Walmart at 9PM EST'));
  assert.ok(text.includes('## Pokemon'));
  assert.ok(text.includes('## Sports Cards'));
  assert.ok(text.includes('https://www.walmart.com/ip/PokeFinder/5999'));
});

import { drawOverWithQueue } from '../src/queue-copy.js';
import { layoutFor, BOX, GAP, MARGIN } from '../src/grid.js';

// A ten item drop laid out 5 by 2 is a two and a half to one strip, which
// Twitter crops in the timeline. Nothing should get that wide.
test('grids stay near square as the count grows', () => {
  for (let n = 4; n <= 20; n++) {
    const l = layoutFor(n);
    const w = MARGIN * 2 + l.cols * BOX + (l.cols - 1) * GAP;
    const h = MARGIN * 2 + l.rows * BOX + (l.rows - 1) * GAP;
    assert.ok(w / h <= 2.1, `${n} items is ${(w / h).toFixed(2)} to 1`);
  }
});

test('grid layouts follow the established conventions', () => {
  assert.deepEqual(layoutFor(3).counts, [3]);
  assert.deepEqual(layoutFor(5).counts, [3, 2]);
  assert.deepEqual(layoutFor(7).counts, [4, 3]);
  assert.deepEqual(layoutFor(9).counts, [3, 3, 3]);
  assert.deepEqual(layoutFor(10).counts, [4, 3, 3]);
  assert.deepEqual(layoutFor(12).counts, [4, 4, 4]);
});

// The canvas is as wide as the fullest row. Sizing it from the column count
// being tried leaves an empty column's worth of dead space.
test('the canvas width matches the fullest row', () => {
  for (let n = 1; n <= 20; n++) {
    const l = layoutFor(n);
    assert.equal(l.cols, Math.max(...l.counts), `${n} items`);
    assert.equal(l.counts.reduce((a, b) => a + b, 0), n, `${n} items`);
  }
});

test('the combined closing post hands off to the queue and carries the ad tag', () => {
  const text = drawOverWithQueue({
    items: [item('Pokemon TCG 30th Celebration ETB', 5999, 'pokemon')],
    dropAt: et('2026-10-28T21:00'),
  });
  assert.ok(text.startsWith("💫 Today's Walmart Draw is Now Over! Next we have a Walmart Queue drop at 9PM EST / 6PM PST!"));
  assert.ok(text.includes('Queue Link: https://howl.link/ffngiff7nu8la'));
  assert.ok(text.includes('Pokemon\n• 30th Celebration ETB'));
  // It carries a link now, so unlike the ordinary closing post it ends at #ad.
  assert.ok(text.endsWith('#Pokemon #ad'));
});

// When a draw or a drop opens, the monitor posts every item a second time,
// marked live and with no Time field. Before this was handled, each one looked
// like a draw embed that failed to parse and raised an alert.
test('go live embeds are ignored by both parsers', () => {
  const live = {
    ...queueEmbed,
    fields: queueEmbed.fields.map((f) => (f.name === 'Type' ? { name: 'Type', value: 'Queue Now Live' } : f)),
  };
  assert.equal(parseQueueEmbed(live, { now: et('2026-10-27T20:25') }), null);
});

import { parsePotentialQueueEmbed, parsePredicted } from '../src/queue.js';
import { potentialQueuePost } from '../src/queue-copy.js';

// The late queue arrives through the restock monitor, so the author alone
// cannot identify it and ordinary restocks must keep being ignored.
const potentialEmbed = {
  author: { name: 'Walmart US V2' },
  title: '[Potential WM Droplist] Pokemon Trading Card Games First Partner Illustration Collection Series 3',
  thumbnail: { url: 'https://i5.walmartimages.com/asr/potential.jpeg' },
  fields: [
    { name: 'Price', value: 'N/A' },
    { name: 'Type', value: 'Potential Queue' },
    { name: 'PID', value: '20413908978' },
    { name: 'Predicted Price / Seller', value: '24.99 USD / GT Collectibles and Toys' },
    { name: 'Offer Id', value: '712B17615AEB39F4AE336E3D23512690' },
    { name: 'Copyable Pid', value: '20413908978' },
  ],
};

test('a potential queue embed parses, taking its price from the predicted field', () => {
  const i = parsePotentialQueueEmbed(potentialEmbed, { now: et('2026-10-28T20:45') });
  assert.equal(i.pid, '20413908978');
  assert.equal(i.priceDisplay, '$24.99');       // Price itself reads N/A
  assert.equal(i.priceCents, 2499);
  assert.equal(i.seller, 'GT Collectibles and Toys');
  assert.equal(i.classification, 'pokemon');
  assert.equal(i.potential, true);
  assert.equal(i.link, 'https://www.walmart.com/ip/PokeFinder/20413908978');
  // The marker is stripped from the name that reaches the post.
  assert.ok(!/Potential WM Droplist/i.test(i.rawTitle));
  // Pinging at 8:45PM Wednesday means the drop is that same 9PM.
  assert.equal(i.dropAt.toISO(), et('2026-10-28T21:00').toISO());
});

test('an ordinary restock from the same monitor is still ignored', () => {
  const restock = {
    ...potentialEmbed,
    title: 'Pokemon Trading Card Game Prismatic Evolutions Booster Bundle',
    fields: potentialEmbed.fields.map((f) => (f.name === 'Type' ? { name: 'Type', value: 'Restock' } : f)),
  };
  assert.equal(parsePotentialQueueEmbed(restock, { now: et('2026-10-28T20:45') }), null);
});

test('the Droplist and draw monitors are not mistaken for the late queue', () => {
  assert.equal(parsePotentialQueueEmbed(queueEmbed, { now: et('2026-10-27T20:25') }), null);
});

test('predicted prices parse, with or without a seller', () => {
  assert.deepEqual(parsePredicted('24.99 USD / GT Collectibles and Toys'),
    { cents: 2499, display: '$24.99', seller: 'GT Collectibles and Toys' });
  assert.deepEqual(parsePredicted('1,299.00 USD / Walmart.com'),
    { cents: 129900, display: '$1299.00', seller: 'Walmart.com' });
  assert.equal(parsePredicted('').cents, null);
});

test('the late queue draft carries a link per product and ends at the ad tag', () => {
  const text = potentialQueuePost({
    items: [
      { ...item('Pokemon TCG First Partner Illustration Collection Series 3', 2499, 'pokemon'), pid: '20413908978' },
      { ...item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg'), pid: '111' },
    ],
    dropAt: et('2026-10-28T21:00'),
  });
  assert.ok(text.startsWith('💫 Walmart Queue Going Live at 9PM EST / 6PM PST!'));
  assert.ok(text.includes('https://www.walmart.com/ip/PokeFinder/20413908978'));
  // Pokemon leads. Names keep the game that identifies them, shortened.
  const body = text.split('\n\n')[1].split('\n');
  assert.match(body[0], /^First Partner Illustration Collection Series 3 /);
  assert.match(body[1], /^MTG Star Trek Collector Booster /);
  assert.ok(text.endsWith('#Pokemon #ad'));
});

import { resolveLink, isAffiliateLink } from '../src/parse.js';

// The monitor can be set to make each embed's title link an affiliate link.
// When it has been, that link beats anything the bot could reconstruct.
test('an affiliate link on the embed is used as is', () => {
  assert.deepEqual(
    resolveLink({ sourceUrl: 'https://howl.link/abc123', pid: '20413908978' }),
    { link: 'https://howl.link/abc123', affiliate: true },
  );
  assert.ok(isAffiliateLink('https://mavely.app.link/e/xyz'));
});

test('a plain Walmart link falls back to the PokeFinder form', () => {
  assert.deepEqual(
    resolveLink({ sourceUrl: 'https://www.walmart.com/ip/Some-Product/20413908978', pid: '20413908978' }),
    { link: 'https://www.walmart.com/ip/PokeFinder/20413908978', affiliate: false },
  );
});

test('a missing or broken embed link still produces a usable link', () => {
  assert.equal(resolveLink({ sourceUrl: null, pid: '123' }).link, 'https://www.walmart.com/ip/PokeFinder/123');
  assert.equal(resolveLink({ sourceUrl: 'not a url', pid: '123' }).affiliate, false);
});

test('the embed link flows through to the potential queue draft', () => {
  const withLink = { ...potentialEmbed, url: 'https://howl.link/queue99' };
  const i = parsePotentialQueueEmbed(withLink, { now: et('2026-10-28T20:45') });
  assert.equal(i.link, 'https://howl.link/queue99');
  assert.equal(i.affiliate, true);
});

import { potentialQueuePost as latePost, sellerSections } from '../src/queue-copy.js';

// Walmart sells the queue; GT Collectibles and Toys sells its own stock on the
// same page. HK wants those in a list of their own, under the seller's name.
test('a marketplace seller gets its own list under its own heading', () => {
  const text = latePost({
    items: [
      { ...item('Pokemon TCG Mega Evolution Elite Trainer Box', 4999, 'pokemon'), pid: '1', seller: 'Walmart.com' },
      { ...item('Pokemon TCG Prismatic Evolutions Booster Bundle', 3999, 'pokemon'), pid: '2', seller: 'GT Collectibles and Toys' },
      { ...item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg'), pid: '3', seller: null },
    ],
    dropAt: et('2026-10-28T21:00'),
  });
  const blocks = text.split('\n\n');
  // Heading, first party list, seller list, ad tag.
  assert.equal(blocks.length, 4);
  assert.equal(blocks[1].split('\n').length, 2);
  assert.match(blocks[1], /^Mega Evolution ETB /);
  assert.match(blocks[1], /\nMTG Star Trek Collector Booster /);
  assert.equal(blocks[2].split('\n')[0], 'GT Collectibles and Toys');
  assert.match(blocks[2], /\nPrismatic Evolutions Booster Bundle https/);
  assert.equal(blocks[3], '#Pokemon #ad');
});

test('no marketplace items means no heading at all', () => {
  const text = latePost({
    items: [{ ...item('Pokemon TCG Mega Evolution Elite Trainer Box', 4999, 'pokemon'), pid: '1', seller: 'Walmart.com' }],
    dropAt: et('2026-10-28T21:00'),
  });
  assert.equal(text.split('\n\n').length, 3);
});

test('each marketplace seller is its own section, best priority first', () => {
  const sections = sellerSections([
    { ...item('Sports Cards 2025 Topps Chrome Hobby Box', 9999, 'sports'), pid: '1', seller: 'Second Seller' },
    { ...item('Pokemon TCG Prismatic Evolutions Booster Bundle', 3999, 'pokemon'), pid: '2', seller: 'GT Collectibles and Toys' },
    { ...item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg'), pid: '3', seller: 'Second Seller' },
  ]);
  // Nothing first party here, so the first party section drops out entirely.
  assert.deepEqual(sections.map((s) => s.seller), ['GT Collectibles and Toys', 'Second Seller']);
  assert.deepEqual(sections[1].items.map((i) => i.classification), ['mtg', 'sports']);
});

import { queueSummary, shortenQueueName, sportsLine } from '../src/queue-copy.js';

// Pokemon by set alone, every other game by its name, sports by its line.
test('the summary names sets, games and sports lines', () => {
  assert.equal(queueSummary([
    { ...item('Prismatic Evolutions Booster Bundle', 3999, 'pokemon'), set: 'Prismatic Evolutions' },
    { ...item('Mega Evolution Elite Trainer Box', 4999, 'pokemon'), set: 'Mega Evolution' },
    { ...item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg') },
    { ...item('Magic: The Gathering Star Trek Bundle', 2999, 'mtg') },
    { ...item('Sports Cards 2025 Topps Chrome Hobby Box', 9999, 'sports') },
  // Two Magic items, one mention. The set order follows the product lists,
  // which price Mega Evolution above Prismatic Evolutions here.
  ]), 'Mega Evolution, Prismatic Evolutions, Magic The Gathering and Topps Chrome');
});

test('a set with several products is named once', () => {
  assert.equal(queueSummary([
    { ...item('Prismatic Evolutions Booster Bundle', 3999, 'pokemon'), set: 'Prismatic Evolutions' },
    { ...item('Prismatic Evolutions Elite Trainer Box', 4999, 'pokemon'), set: 'Prismatic Evolutions' },
  ]), 'Prismatic Evolutions');
});

test('an unrecognised sports brand falls back to the category', () => {
  assert.equal(sportsLine('Topps Bowman Football Trading Cards Value Box'), 'Topps Bowman');
  assert.equal(sportsLine('2026 Futera Unique Soccer Box'), null);
  assert.equal(queueSummary([item('2026 Futera Unique Soccer Box', 9999, 'sports')]), 'Sports Cards');
});

// Only filler and HK's own two abbreviations come out. Nothing that
// identifies the product does.
test('queue names lose filler but keep what identifies the product', () => {
  assert.equal(
    shortenQueueName('Pokemon Trading Card Games Prismatic Evolutions Elite Trainer Box'),
    'Prismatic Evolutions ETB');
  assert.equal(
    shortenQueueName('Pokemon TCG Mega Evolution Ultra Premium Collection'),
    'Mega Evolution UPC');
  assert.equal(
    shortenQueueName('Magic: The Gathering Star Trek Collector Booster'),
    'MTG Star Trek Collector Booster');
  assert.equal(
    shortenQueueName('One Piece Card Game OP-11 Booster Box'),
    'One Piece OP-11 Booster Box');
  assert.equal(
    shortenQueueName('Topps Bowman Football Trading Cards Value Box'),
    'Topps Bowman Football Value Box');
  // Already short, so untouched.
  assert.equal(shortenQueueName('Prismatic Evolutions Booster Bundle'), 'Prismatic Evolutions Booster Bundle');
});

test('a Pokemon set the naming step could not place still reaches the summary', () => {
  assert.equal(queueSummary([
    { ...item('Pokemon TCG Some Brand New Set Elite Trainer Box', 4999, 'pokemon'), set: null },
    { ...item('Magic: The Gathering Star Trek Collector Booster', 4499, 'mtg') },
  ]), 'Pokemon and Magic The Gathering');
});

// One Piece outranks Magic in the summary, as it does in the lists.
test('One Piece is named straight after Pokemon', () => {
  assert.equal(queueSummary([
    { ...item('Magic: The Gathering Star Trek Collector Booster', 9999, 'mtg') },
    { ...item('One Piece Card Game OP-11 Booster Box', 4999, 'onepiece') },
    { ...item('Prismatic Evolutions Booster Bundle', 3999, 'pokemon'), set: 'Prismatic Evolutions' },
    { ...item('Sports Cards 2025 Topps Chrome Hobby Box', 19999, 'sports') },
  ]), 'Prismatic Evolutions, One Piece, Magic The Gathering and Topps Chrome');
});

test('One Piece outranks Magic even when Magic is the pricier item', () => {
  const text = latePost({
    items: [
      { ...item('Magic: The Gathering Star Trek Collector Booster', 9999, 'mtg'), pid: '1' },
      { ...item('One Piece Card Game OP-11 Booster Box', 4999, 'onepiece'), pid: '2' },
    ],
    dropAt: et('2026-10-28T21:00'),
  });
  const body = text.split('\n\n')[1].split('\n');
  assert.match(body[0], /^One Piece OP-11 Booster Box /);
  assert.match(body[1], /^MTG Star Trek Collector Booster /);
  assert.ok(text.startsWith('💫 Walmart Queue Going Live at 9PM EST / 6PM PST! One Piece and Magic The Gathering!'));
});
