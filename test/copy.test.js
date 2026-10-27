import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { buildPosts, winsPost, discordPost, setsLabel, timeLabel, shortDate } from '../src/copy.js';

// The real Walmart draw of 26 October 2026, as published to PokemonFindr.
// These expected strings are copied from the sent posts, so a change in the
// composer that alters the wording fails here rather than on Twitter.
const startsAt = DateTime.fromISO('2026-10-26T17:00', { zone: 'America/New_York' });
const endsAt = startsAt.plus({ hours: 1 });
const items = [{ postName: 'Prismatic Evolutions Booster Bundle 2-Pack', priceDisplay: '$79.94' }];
const sets = ['Prismatic Evolutions'];

const posts = buildPosts({ items, sets, startsAt, endsAt });
const bySlot = Object.fromEntries(posts.map((p) => [p.slot, p]));

const TIPS_BLOCK = `Tips for Success:
• Save your delivery address and default credit or debit card on your Walmart account before entering
• PayPal does not work, so a credit or debit card must be saved
• If your entry gets rejected, remove and re-enter your address in settings and set it as default
• Entries stay open for 1 hour and the site slows down, so there is no rush`;

const BOOKMARK_LINE = "🛎️ Bookmark & Follow, We'll Post When The Draw Goes Live! We'll Also Post Any New Draws That Get Added!";
const LINK = 'Enter Draw Here: https://howl.link/r5frrzi6qe8hx';
const ITEM = '• Prismatic Evolutions Booster Bundle 2-Pack $79.94';

test('announcement matches the published post', () => {
  assert.equal(bySlot.announcement.text, [
    '💫 New Prismatic Evolutions Walmart Draw Beginning 10/26 at 5PM EST / 2PM PST!',
    LINK, ITEM, BOOKMARK_LINE, '#Pokemon #ad',
  ].join('\n\n'));
});

test('morning reminder matches the published post', () => {
  assert.equal(bySlot.morning.text, [
    '💫 Reminder! Prismatic Evolutions Walmart Draw Going Live Today at 5PM EST / 2PM PST!',
    LINK, ITEM, TIPS_BLOCK, BOOKMARK_LINE, '#Pokemon #ad',
  ].join('\n\n'));
});

test('ten minute reminder matches the published post', () => {
  assert.equal(bySlot.ten_minutes.text, [
    '💫 Reminder: Prismatic Evolutions Walmart Draw Going Live in 10 Minutes!',
    LINK, ITEM, TIPS_BLOCK, BOOKMARK_LINE, '#Pokemon #ad',
  ].join('\n\n'));
});

test('going live matches the published post and drops the bookmark line', () => {
  assert.equal(bySlot.going_live.text, [
    '💫 Walmart Prismatic Evolutions Draw Going Live! Entries Accepted for 1 Hour!',
    LINK, ITEM, TIPS_BLOCK, '#Pokemon #ad',
  ].join('\n\n'));
  assert.ok(!bySlot.going_live.text.includes('Bookmark'));
});

test('thirty minutes left matches the published post, with no tips and no bookmark', () => {
  assert.equal(bySlot.thirty_left.text, [
    '💫 30 Minutes Left to Enter the Walmart Prismatic Evolutions Draw!',
    LINK, ITEM, '#Pokemon #ad',
  ].join('\n\n'));
  assert.ok(!bySlot.thirty_left.text.includes('Tips for Success'));
});

// The closing post carries no link, so it ends at #Pokemon with no #ad.
test('the over post matches the published post and carries no ad tag', () => {
  assert.equal(bySlot.over.text, [
    "💫 Today's Walmart Draw is now over! We will post as soon as wins start going out!",
    "Follow & Turn Notifications On! We'll post the next draws as soon as they're announced!",
    '#Pokemon',
  ].join('\n\n'));
  assert.ok(!bySlot.over.text.includes('#ad'));
});

test('the wins post is drafted in the agreed wording', () => {
  assert.match(winsPost(), /^✨️Wins from Today's Walmart Draws Are Starting to Go Out!/);
  assert.ok(winsPost().includes('Check Here: https://buff.ly/xswHYG8'));
  assert.ok(winsPost().endsWith('#Pokemon #ad'));
});

test('each post is scheduled to its own anchor off the start time', () => {
  const at = (slot) => bySlot[slot].dueAt.setZone('America/New_York').toFormat('HH:mm');
  assert.equal(bySlot.announcement.dueAt, null);
  assert.equal(at('morning'), '09:00');
  assert.equal(at('ten_minutes'), '16:50');
  assert.equal(at('going_live'), '16:59');   // one minute before, not at the start
  assert.equal(at('thirty_left'), '17:30');
  assert.equal(at('over'), '18:00');
});

// A 12PM draw must move every anchor with it, not keep the 5PM ones.
test('a midday draw moves its anchors', () => {
  const noon = DateTime.fromISO('2026-10-07T12:00', { zone: 'America/New_York' });
  const p = Object.fromEntries(
    buildPosts({ items, sets, startsAt: noon, endsAt: noon.plus({ hours: 1 }) })
      .map((x) => [x.slot, x]),
  );
  const at = (slot) => p[slot].dueAt.setZone('America/New_York').toFormat('HH:mm');
  assert.equal(at('morning'), '09:00');
  assert.equal(at('ten_minutes'), '11:50');
  assert.equal(at('going_live'), '11:59');
  assert.equal(at('thirty_left'), '12:30');
  assert.equal(at('over'), '13:00');
});

test('30th Anniversary leads the set list however the items arrive', () => {
  assert.equal(setsLabel(['Prismatic Evolutions', '30th Anniversary']), '30th Anniversary and Prismatic Evolutions');
  assert.equal(
    setsLabel(['Ascended Heroes', 'Prismatic Evolutions', '30th Anniversary']),
    '30th Anniversary, Ascended Heroes and Prismatic Evolutions',
  );
});

test('several sets make the noun plural', () => {
  const multi = buildPosts({
    items, sets: ['30th Anniversary', 'Prismatic Evolutions'], startsAt, endsAt,
  });
  assert.match(multi[0].text, /^💫 New 30th Anniversary and Prismatic Evolutions Walmart Draws Beginning/);
});

test('times and short dates are written the way the posts write them', () => {
  assert.equal(timeLabel(startsAt), '5PM EST / 2PM PST');
  assert.equal(shortDate(startsAt), '10/26');
  assert.equal(
    timeLabel(DateTime.fromISO('2026-10-07T12:30', { zone: 'America/New_York' })),
    '12:30PM EST / 9:30AM PST',
  );
});

test('the Discord post carries the countdown and tags the role with a leading space', () => {
  const text = discordPost({ items, sets, startsAt });
  const epoch = Math.floor(startsAt.toSeconds());
  assert.ok(text.startsWith('# New Walmart Draws Beginning 10/26 at 5PM EST / 2PM PST'));
  assert.ok(text.includes(`<t:${epoch}:F> (<t:${epoch}:R>)** @PokeFinder+`));
  assert.ok(text.includes('**Items for Upcoming Draw:**'));
  assert.ok(text.includes('# Draw Link: [Walmart Collectibles Draw](https://howl.link/swe1iqp31stef)'));
  // The tweets and the Discord post use different links on purpose.
  assert.ok(!text.includes('r5frrzi6qe8hx'));
});

// Guard against the announcement losing its place at the head of the set.
// It is the only post that races anyone, so it has to be created first.
test('the announcement is composed first', () => {
  assert.equal(posts[0].slot, 'announcement');
});
