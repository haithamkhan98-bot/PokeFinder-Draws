import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  isRaffleEmbed, parseTargetRaffle, raffleLink, usableRaffleItems, readDrawingDate,
} from '../src/target-raffle.js';
import {
  buildRafflePosts, raffleItemLines, deadlineClause, targetDiscordPosts, productHeadline, raffleHeadline,
} from '../src/target-copy.js';

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
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'night', 'closing']);
  assert.deepEqual(posts.map((p) => p.discord), [true, false, true]);
  // 10PM Eastern the evening before the close, not the morning after opening.
  assert.equal(posts[1].dueAt.toFormat('ccc HH:mm'), 'Wed 22:00');
  assert.equal(posts[2].dueAt.toISO(), closesAt.minus({ hours: 1 }).toISO());
});

test('the night reminder is skipped on a draw that closes the same day', () => {
  // Opens 11AM, closes 8PM: 10PM the night before is before it even opened.
  const posts = buildRafflePosts({
    items: [{ postName: 'A', link: 'x' }], now, closesAt: now.set({ hour: 20 }),
  });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});

test('the night reminder is skipped when it lands within three hours of the announcement', () => {
  // Announced 8PM, closes tomorrow 11AM: 10PM tonight would repeat the post.
  const evening = now.set({ hour: 20 });
  const posts = buildRafflePosts({
    items: [{ postName: 'A', link: 'x' }], now: evening, closesAt: evening.plus({ days: 1 }).set({ hour: 11 }),
  });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});

test('the night reminder is skipped when it lands within two hours of the close', () => {
  // Closes at midnight: 10PM the night before is two hours out, which is the
  // closing post's stretch (it goes at 11PM).
  const closesAt = now.plus({ days: 1 }).set({ hour: 0, minute: 0 });
  const posts = buildRafflePosts({ items: [{ postName: 'A', link: 'x' }], now, closesAt });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});

test('the night reminder is timed from the announcement, not from when it is built', () => {
  const closesAt = DateTime.fromISO('2026-11-19T11:00', { zone: 'America/New_York' });
  const openedAt = DateTime.fromISO('2026-11-18T13:00', { zone: 'America/New_York' });
  // The ticker builds it at 9:45PM; the 3 hour rule must look at 1PM.
  const posts = buildRafflePosts({
    items: [{ postName: 'A', link: 'x' }], now: openedAt.set({ hour: 21, minute: 45 }), openedAt, closesAt,
  });
  assert.equal(posts.find((p) => p.slot === 'night').dueAt.toFormat('LLL d HH:mm'), 'Nov 18 22:00');
});

test('the headline names the products, folding variants and saying the set once', () => {
  const items = [
    { set: '30th Celebration', postName: '30th Celebration Ultra-Premium Collection - Day', link: 'a' },
    { set: '30th Celebration', postName: '30th Celebration Ultra-Premium Collection - Night', link: 'b' },
    { set: '30th Celebration', postName: '30th Celebration Ditto Premium Collection', link: 'c' },
  ];
  assert.equal(
    productHeadline(items),
    '30th Celebration Ultra-Premium Collection Day and Night and Ditto Premium Collection',
  );
  assert.equal(raffleHeadline(items), productHeadline(items));
});

test('sheet style variants, with no dash, fold the same way', () => {
  const items = [
    { set: '30th Celebration', postName: '30th Celebration Ultra Premium Collection Day', link: 'a' },
    { set: '30th Celebration', postName: '30th Celebration Ultra Premium Collection Night', link: 'b' },
    { set: '30th Celebration', postName: '30th Celebration Ditto Premium Collection', link: 'c' },
  ];
  assert.equal(
    productHeadline(items),
    '30th Celebration Ultra Premium Collection Day and Night and Ditto Premium Collection',
  );
});

test('too many products, or too long a headline, falls back to the set names', () => {
  const many = ['A', 'B', 'C', 'D'].map((x) => ({ set: 'Mega Evolution', postName: `Mega Evolution ${x} Box`, link: x }));
  assert.equal(productHeadline(many), null);
  assert.equal(raffleHeadline(many), 'Mega Evolution');
  const long = [{ set: 'S', postName: 'X'.repeat(130), link: 'a' }];
  assert.equal(raffleHeadline(long), 'S');
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
    '💫 Target 30th Celebration Booster Bundle Box Draws Are Live Now! Entries Accepted by November 11 at 11AM EST / 8AM PST!',
  );
  assert.match(first(posts[1]), /Still Open! Entries Accepted by November 11 at 11AM EST \/ 8AM PST!$/);
  // Inside the final hour the date is noise.
  assert.equal(first(posts[2]), '💫 1 Hour Left to Enter the Target 30th Celebration Booster Bundle Box Draws! Entries Close at 11AM EST / 8AM PST!');
  for (const p of posts) assert.doesNotMatch(p.text, /⏰/, 'no separate deadline block');
});

test('without a close time the announcement still goes out, with no deadline line', () => {
  const posts = buildRafflePosts({ items: SAMPLE, now, closesAt: null });
  assert.deepEqual(posts.map((p) => p.slot), ['live']);
  assert.equal(posts[0].text.split('\n')[0], '💫 Target 30th Celebration Booster Bundle Box Draws Are Live Now!');
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

const closesAt = DateTime.fromISO('2026-11-11T10:00', { zone: 'America/Chicago' });

test('the member Discord posts are the live and closing beats only', () => {
  const posts = targetDiscordPosts({ items: SAMPLE, now, closesAt, role: '<@&123>' });
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
  // Not the night one: members got the announcement and will get the hour
  // warning, and a third ping is what makes people mute a role.
  assert.ok(!posts.some((p) => p.slot === 'night'));
});

test('the member posts use Discord timestamps rather than a written clock time', () => {
  const epoch = Math.floor(closesAt.toSeconds());
  const [live, closing] = targetDiscordPosts({ items: SAMPLE, now, closesAt, role: '<@&123>' });
  assert.match(live.text, new RegExp(`<t:${epoch}:F>`), 'renders in each member\'s own timezone');
  assert.match(live.text, new RegExp(`<t:${epoch}:R>`), 'and counts itself down');
  assert.match(closing.text, new RegExp(`<t:${epoch}:R>`));
  assert.doesNotMatch(live.text, /11AM EST/, 'a written time would go stale across days');
});

test('the member posts ping with the role ID, since the literal text does not', () => {
  const [live] = targetDiscordPosts({ items: SAMPLE, now, closesAt, role: '<@&123>' });
  assert.match(live.text, /<@&123>/);
});

test('the closing member post is due an hour before the close', () => {
  const [, closing] = targetDiscordPosts({ items: SAMPLE, now, closesAt });
  assert.equal(closing.dueAt.toMillis(), closesAt.minus({ hours: 1 }).toMillis());
});

test('every item carries its own link, because Target has no catchall page', () => {
  const [live] = targetDiscordPosts({ items: SAMPLE, now, closesAt });
  assert.match(live.text, /- \[30th Celebration Booster Bundle Box\]\(https:\/\/[^)]+\)/);
  assert.doesNotMatch(live.text, /Draw Link/, 'the Walmart footer has no Target equivalent');
});

test('with no close time there are no member posts', () => {
  // The whole post is built around the deadline countdown, so there is nothing
  // to say without one. The tweets still go out.
  assert.deepEqual(targetDiscordPosts({ items: SAMPLE, now, closesAt: null }), []);
});

test('both member Discord posts say what winning commits you to', () => {
  for (const p of targetDiscordPosts({ items: SAMPLE, now, closesAt, role: '<@&1>' })) {
    assert.match(p.text, /Winners will have 24 hours to complete their purchase if selected!$/);
  }
});

test('the tweets do not carry the winners note', () => {
  // They are already near the limit with the deadline in the opening line, and
  // the people who need it are deciding whether to enter, not scrolling past.
  for (const p of buildRafflePosts({ items: SAMPLE, now, closesAt })) {
    assert.doesNotMatch(p.text, /24 hours/);
  }
});

// The embed as the monitor sends it since Nov 18: Type "Drawing Open" and a
// Drawing Date field rendered from a Discord timestamp.
const drawing = (over = {}) => embed({
  title: 'Pokémon Trading Card Game: 30th Celebration Ultra-Premium Collection- Day',
  fields: [
    { name: 'Price', value: 'N/A USD' },
    { name: 'Type', value: 'Drawing Open' },
    { name: 'Tcin', value: '1012850570' },
    { name: 'Queue Status', value: '🟢' },
    { name: 'Raffle Status', value: '🟢' },
    { name: 'Drawing Date', value: '<t:1795104000:f>' },
  ],
  ...over,
});
const nov18 = DateTime.fromISO('2026-11-18T12:54', { zone: 'America/New_York' });

test('the close time comes off the embed, so the bookmarklet is not needed', () => {
  const i = parseTargetRaffle(drawing(), { now: nov18 });
  assert.ok(isRaffleEmbed(drawing()));
  assert.equal(i.closesAt.toISO(), '2026-11-19T11:00:00.000-05:00');
  assert.equal(i.type, 'Drawing Open');
  assert.equal(parseTargetRaffle(embed(), { now }).closesAt, null, 'an older embed has none');
});

test('the Drawing Date reads as a timestamp or as written text', () => {
  const want = '2026-11-19T11:00:00.000-05:00';
  assert.equal(readDrawingDate('<t:1795104000:F>').toISO(), want);
  assert.equal(readDrawingDate('<t:1795104000>').toISO(), want);
  assert.equal(readDrawingDate('November 19, 2026 11:00 AM').toISO(), want, 'Eastern when unzoned');
  assert.equal(readDrawingDate('November 19, 2026 10:00 AM CT').toISO(), want);
  assert.equal(readDrawingDate('`November 19, 2026 11:00 AM`').toISO(), want, 'inline code');
  assert.equal(readDrawingDate('soon'), null);
  assert.equal(readDrawingDate(null), null);
});

test('a draw already closed, or a closing notice, is not announced', () => {
  const open = parseTargetRaffle(drawing(), { now: nov18 });
  assert.equal(usableRaffleItems([open], { now: nov18 }).length, 1);
  assert.equal(usableRaffleItems([open], { now: open.closesAt.plus({ minutes: 1 }) }).length, 0);
  const closed = { ...open, type: 'Drawing Closed' };
  assert.equal(usableRaffleItems([closed], { now: nov18 }).length, 0);
});

test('the monitor\'s "Collection- Day" titles fold like any other variant', () => {
  const items = [
    { set: '30th Celebration', postName: '30th Celebration Ultra-Premium Collection- Day', link: 'a' },
    { set: '30th Celebration', postName: '30th Celebration Ultra-Premium Collection- Night', link: 'b' },
  ];
  assert.equal(productHeadline(items), '30th Celebration Ultra-Premium Collection Day and Night');
});
