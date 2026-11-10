import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { isRaffleEmbed, parseTargetRaffle, raffleLink, usableRaffleItems } from '../src/target-raffle.js';
import { buildRafflePosts, raffleItemLines, deadlineClause } from '../src/target-copy.js';

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

// As runTargetRaffle has it: the parsed embed merged with the naming step's
// set and postName, which is what the copy actually receives.
const SAMPLE = [{
  ...parseTargetRaffle(embed(), { now }),
  set: '30th Celebration',
  postName: '30th Celebration Booster Bundle Box',
}];

test('every beat states the deadline, which is why the close time is collected', () => {
  // Target writes its copy in Central ("Enter by 10am CT"), so the posts have
  // to come out as 11AM Eastern.
  const closesAt = DateTime.fromISO('2026-11-11T10:00', { zone: 'America/Chicago' });
  const posts = buildRafflePosts({ items: SAMPLE, now, closesAt });

  assert.equal(posts.length, 3);
  // The deadline belongs in the opening line, where someone scrolling sees it.
  const first = (p) => p.text.split('\n')[0];
  assert.equal(
    first(posts[0]),
    '💫 Target 30th Celebration Draws Are Live Now! Entries Accepted by November 11 at 11AM EST / 8AM PST!',
  );
  assert.match(first(posts[1]), /Still Open! Entries Accepted by November 11 at 11AM EST \/ 8AM PST!$/);
  // Inside the final hour the date is noise.
  assert.equal(first(posts[2]), '💫 1 Hour Left to Enter the Target 30th Celebration Draws! Entries Close at 11AM EST / 8AM PST!');
  for (const p of posts) assert.doesNotMatch(p.text, /⏰/, 'no separate deadline block');
});

test('without a close time the announcement still goes out, with no deadline line', () => {
  const posts = buildRafflePosts({ items: SAMPLE, now, closesAt: null });
  assert.deepEqual(posts.map((p) => p.slot), ['live']);
  assert.equal(posts[0].text.split('\n')[0], '💫 Target 30th Celebration Draws Are Live Now!');
  assert.doesNotMatch(posts[0].text, /Entries/, 'no dangling deadline clause');
});

test('the deadline crosses a DST boundary by zone rather than by offset', () => {
  // 2026 DST ends Nov 1. 10am Central must come out as 11AM Eastern either side.
  const before = deadlineClause(DateTime.fromISO('2026-10-28T10:00', { zone: 'America/Chicago' }));
  const after = deadlineClause(DateTime.fromISO('2026-11-11T10:00', { zone: 'America/Chicago' }));
  assert.match(before, /October 28 at 11AM EST \/ 8AM PST/);
  assert.match(after, /November 11 at 11AM EST \/ 8AM PST/);
  assert.equal(deadlineClause(null), null);
});
