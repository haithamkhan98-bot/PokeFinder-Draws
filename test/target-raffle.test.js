import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { isRaffleEmbed, parseTargetRaffle, raffleLink, usableRaffleItems } from '../src/target-raffle.js';
import { buildRafflePosts, raffleItemLines } from '../src/target-copy.js';

const now = DateTime.fromISO('2026-11-09T11:00', { zone: 'America/New_York' });

const embed = (over = {}) => ({
  author: { name: 'Target Raffles' },
  title: 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box',
  url: 'https://howl.link/pnde1mqwzvksi',
  thumbnail: { url: 'https://target.scene7.com/x.jpeg' },
  fields: [
    { name: 'Price', value: 'N/A USD' },
    { name: 'Type', value: 'Restock' },
    { name: 'Tcin', value: '1011407490' },
    { name: 'Queue Status', value: '🟢' },
    { name: 'Raffle Status', value: '🟢' },
  ],
  ...over,
});

test('a raffle is told from a restock by the Raffle Status field, not Type', () => {
  assert.ok(isRaffleEmbed(embed()));
  // Type says Restock on a real raffle, so it cannot be the discriminator.
  assert.equal(embed().fields.find((f) => f.name === 'Type').value, 'Restock');
  // An ordinary restock carries no Raffle Status at all.
  const restock = embed({ fields: embed().fields.filter((f) => f.name !== 'Raffle Status') });
  assert.equal(isRaffleEmbed(restock), false);
  // Another monitor's embed is never a Target raffle.
  assert.equal(isRaffleEmbed(embed({ author: { name: 'Walmart Droplist' } })), false);
});

test('links: zephyr, bare target.com and missing all fall back to the slug form', () => {
  const plain = 'https://www.target.com/p/PokeFinder/A-1011407490';
  assert.deepEqual(raffleLink('https://howl.link/abc', '1011407490'),
    { link: 'https://howl.link/abc', affiliate: true });
  assert.deepEqual(raffleLink('https://howl.link/zephyr-xyz', '1011407490'),
    { link: plain, affiliate: false });
  // Target's own URL form is normalised to HK's slug form.
  assert.deepEqual(raffleLink('https://www.target.com/p/some-slug/-/A-1011407490', '1011407490'),
    { link: plain, affiliate: false });
  assert.deepEqual(raffleLink(null, '1011407490'), { link: plain, affiliate: false });
  assert.deepEqual(raffleLink('not a url', '1011407490'), { link: plain, affiliate: false });
});

test('parse pulls the tcin and keeps no price, since Target sends none', () => {
  const i = parseTargetRaffle(embed(), { now });
  assert.equal(i.tcin, '1011407490');
  assert.equal(i.link, 'https://howl.link/pnde1mqwzvksi');
  assert.equal(i.affiliate, true);
  assert.equal(i.priceDisplay, null);
  assert.equal(i.classification, 'pokemon');
  assert.equal(parseTargetRaffle(embed({ fields: [] }), { now }), null);
});

test('repacks are excluded here too', () => {
  const items = [embed(), embed({ title: 'Pokemon Mystery Power Box' })]
    .map((e) => parseTargetRaffle(e, { now }));
  assert.equal(usableRaffleItems(items).length, 1);
});

test('every item carries its own link, since Target has no catchall page', () => {
  const items = [
    { postName: 'A', link: 'https://howl.link/a' },
    { postName: 'B', link: 'https://www.target.com/p/PokeFinder/A-2' },
  ];
  assert.equal(raffleItemLines(items), 'A https://howl.link/a\nB https://www.target.com/p/PokeFinder/A-2');
});

test('with no close time, only the live post is built', () => {
  const posts = buildRafflePosts({ items: [{ postName: 'A', link: 'x' }], now });
  assert.deepEqual(posts.map((p) => p.slot), ['live']);
  assert.equal(posts[0].dueAt, null);
  assert.equal(posts[0].discord, true);
});

test('with a close time, all three fire and Discord gets live plus closing', () => {
  const closesAt = now.plus({ days: 3 });
  const posts = buildRafflePosts({ items: [{ postName: 'A', link: 'x' }], now, closesAt });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'morning', 'closing']);
  assert.deepEqual(posts.map((p) => p.discord), [true, false, true]);
  assert.equal(posts[1].dueAt.toFormat('ccc HH:mm'), 'Tue 09:00');
  assert.equal(posts[2].dueAt.toISO(), closesAt.minus({ hours: 1 }).toISO());
});

test('the morning reminder is skipped on a draw that closes before it', () => {
  // Opens 11AM, closes 8PM the same day: 9AM tomorrow is long past the close.
  const posts = buildRafflePosts({
    items: [{ postName: 'A', link: 'x' }], now, closesAt: now.set({ hour: 20 }),
  });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});

test('the morning reminder is skipped when it lands inside the final hour', () => {
  const closesAt = now.plus({ days: 1 }).set({ hour: 9, minute: 30 });
  const posts = buildRafflePosts({ items: [{ postName: 'A', link: 'x' }], now, closesAt });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});
