import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseSummaryEmbed, nextPostAt, summaryDate, parseStates, byRegion, REGIONS } from '../src/bestbuy.js';
import { bestbuyDigest, shortTitle, DISCORD_LIMIT } from '../src/bestbuy-copy.js';

const et = (i) => DateTime.fromISO(i, { zone: 'America/New_York' });

const summaryEmbed = {
  author: { name: 'BestBuy US Instore Summary' },
  title: 'Pokémon - Trading Card Game: Scarlet & Violet Destined Rivals Elite Trainer Box',
  url: 'https://www.bestbuy.com/site/x/6624825.p',
  thumbnail: { url: 'https://pisces.bbystatic.com/6624825.jpg' },
  fields: [
    { name: 'Price', value: '$49.99' },
    { name: 'Type', value: 'Daily Summary' },
    { name: 'SKU', value: '6624825' },
    { name: 'States [Stock]', value: 'California [242]\nFlorida [79]\nOhio [60]' },
    { name: 'States [Stock]', value: 'Texas [102]\nNew Jersey [65]\nIllinois [59]' },
  ],
};

test('a Daily Summary embed parses, merging both state columns', () => {
  const i = parseSummaryEmbed(summaryEmbed, { now: et('2026-10-31T01:10') });
  assert.equal(i.sku, '6624825');
  assert.equal(i.priceDisplay, '$49.99');
  assert.equal(i.states, 6);
  assert.equal(i.units, 242 + 79 + 60 + 102 + 65 + 59);
  assert.deepEqual(i.stock, { CA: 242, FL: 79, OH: 60, TX: 102, NJ: 65, IL: 59 });
  assert.equal(i.link, 'https://www.bestbuy.com/site/x/6624825.p');
  assert.deepEqual(i.unknownStates, []);
});

test('other embeds in the channel are ignored', () => {
  assert.equal(parseSummaryEmbed({ ...summaryEmbed, author: { name: 'Walmart Droplist' } }), null);
  const restock = { ...summaryEmbed, fields: summaryEmbed.fields.map((f) => (f.name === 'Type' ? { ...f, value: 'Restock' } : f)) };
  assert.equal(parseSummaryEmbed(restock), null);
});

test('an unreadable summary says what is missing instead of throwing', () => {
  const broken = { ...summaryEmbed, fields: [{ name: 'Type', value: 'Daily Summary' }] };
  assert.match(parseSummaryEmbed(broken).error, /missing SKU, States \[Stock\]/);
});

// Every state the monitor can name has to land in a region, or units vanish
// from the totals without anyone noticing.
test('every mapped state belongs to exactly one region', () => {
  const seen = new Set();
  for (const states of Object.values(REGIONS)) {
    for (const s of states.split(' ')) {
      assert.ok(!seen.has(s), `${s} is in two regions`);
      seen.add(s);
    }
  }
  assert.equal(seen.size, 51); // 50 states plus DC
});

test('region totals add back up to the unit total', () => {
  const { stock } = parseStates('California [242]\nTexas [102]\nOhio [60]\nFlorida [79]\nMaine [8]');
  const r = byRegion(stock);
  assert.equal(Object.values(r).reduce((a, b) => a + b, 0), 242 + 102 + 60 + 79 + 8);
  assert.deepEqual(r, { West: 242, Southwest: 102, Southeast: 79, Midwest: 60, Northeast: 8 });
});

test('an unrecognised state is reported rather than silently dropped', () => {
  const { stock, unknown } = parseStates('California [10]\nPuerto Rico [5]');
  assert.deepEqual(stock, { CA: 10 });
  assert.deepEqual(unknown, ['Puerto Rico']);
});

// Embeds land around 1AM and the digest goes out at 7AM the same morning.
test('the post goes to the next 7AM that has not passed', () => {
  assert.equal(nextPostAt(et('2026-10-31T01:10')).toFormat('ccc LLL d HH:mm'), 'Sat Oct 31 07:00');
  assert.equal(nextPostAt(et('2026-10-31T03:40')).toFormat('ccc LLL d HH:mm'), 'Sat Oct 31 07:00');
  assert.equal(nextPostAt(et('2026-10-31T22:00')).toFormat('ccc LLL d HH:mm'), 'Sun Nov 1 07:00');
  assert.equal(nextPostAt(et('2026-10-31T07:30')).toFormat('ccc LLL d HH:mm'), 'Sun Nov 1 07:00');
});

test('embeds through the night share one post key', () => {
  assert.equal(summaryDate(et('2026-10-31T01:10')), summaryDate(et('2026-10-31T03:40')));
});

test('BestBuy titles shorten to how a collector writes them', () => {
  assert.equal(shortTitle('Pokémon - Trading Card Game: Scarlet & Violet Destined Rivals Elite Trainer Box'),
    'Destined Rivals ETB');
  assert.equal(shortTitle('Pokémon - Trading Card Game: 30th Celebration Elite Trainer Box'),
    '30th Celebration ETB');
  assert.equal(shortTitle('Pokémon - Trading Card Game: 30th Celebration Sylveon ex Box or Greninja ex Box (1 Ex Box per Order) - Styles May Vary'),
    '30th Celebration Sylveon ex Box or Greninja ex Box');
});

const item = (rawTitle, units, regions, extra = {}) =>
  ({ rawTitle, units, states: 40, regions, priceDisplay: '$49.99', merch: false, ...extra });

test('products are ordered by units, biggest restock first', () => {
  const d = bestbuyDigest({
    items: [item('Small Thing', 100, { West: 100 }), item('Big Thing', 900, { West: 900 })],
    role: '<@&1>', checkerChannel: '<#2>',
  });
  assert.ok(d.text.indexOf('Big Thing') < d.text.indexOf('Small Thing'));
  assert.ok(d.text.startsWith('# BestBuy Instore Drops'));
  assert.ok(d.text.endsWith('restocking!'));
});

test('merchandise is left out of the digest', () => {
  const d = bestbuyDigest({
    items: [item('Pokemon Pikachu Plush', 500, { West: 500 }, { merch: true }), item('Real ETB', 100, { West: 100 })],
    role: '<@&1>', checkerChannel: '<#2>',
  });
  assert.ok(!d.text.includes('Plush'));
  assert.equal(d.items.length, 1);
});

test('nothing postable returns null rather than an empty post', () => {
  assert.equal(bestbuyDigest({ items: [], role: '<@&1>', checkerChannel: '<#2>' }), null);
  assert.equal(bestbuyDigest({ items: [item('Plush', 1, {}, { merch: true })], role: '<@&1>', checkerChannel: '<#2>' }), null);
});

// A very large summary must not silently lose products off the bottom.
test('an oversized digest drops detail, never products', () => {
  const many = Array.from({ length: 30 }, (_, n) =>
    item(`Pokemon Trading Card Game A Fairly Long Product Name Number ${n + 1}`, 1000 - n,
      { Midwest: 400, West: 300, Northeast: 200, Southeast: 60, Southwest: 40 }));
  const d = bestbuyDigest({ items: many, role: '<@&1>', checkerChannel: '<#2>' });
  assert.ok(d.text.length <= DISCORD_LIMIT, `${d.text.length} chars is over the limit`);
  assert.notEqual(d.form, 'full');
  assert.equal(d.items.length, 30);
  for (const i of many) assert.ok(d.text.includes(shortTitle(i.rawTitle)), `${i.rawTitle} fell off`);
});

// Daily Summaries carry sports cards too. They should read like the Pokemon
// ones, not keep BestBuy's "Trading Cards" filler.
test('non Pokemon titles shorten too', () => {
  assert.equal(shortTitle('2026 Topps Bowman Chrome Football Trading Cards Value Box'),
    '2026 Topps Bowman Chrome Football Value Box');
  assert.equal(shortTitle('One Piece Card Game OP-11 Booster Box'),
    'One Piece OP-11 Booster Box');
});

// The preview must be able to render a mixed night without the role pinging.
test('a mixed night renders with merchandise filtered out', () => {
  const mk = (rawTitle, stock, merch = false) => ({
    rawTitle, priceDisplay: '$49.99', stock,
    units: Object.values(stock).reduce((a, b) => a + b, 0),
    states: Object.keys(stock).length, regions: byRegion(stock), merch,
  });
  const d = bestbuyDigest({
    items: [
      mk('Pokémon - Trading Card Game: 30th Celebration Elite Trainer Box', { CA: 536, TX: 460 }),
      mk('2026 Topps Bowman Chrome Football Trading Cards Value Box', { TX: 120, AZ: 40 }),
      mk('Pokemon Pikachu Plush 8in', { CA: 50 }, true),
    ],
    role: '<@&1>', checkerChannel: '<#2>',
  });
  assert.equal(d.items.length, 2);
  assert.ok(!d.text.includes('Plush'));
  assert.ok(d.text.includes('2026 Topps Bowman Chrome Football Value Box'));
  assert.ok(d.text.includes('<@&1>') && d.text.includes('<#2>'));
});
