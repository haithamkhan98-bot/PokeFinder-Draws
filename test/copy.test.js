import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { buildPosts, winsPost, discordPost, buildDiscordPosts, setsLabel, timeLabel, shortDate } from '../src/copy.js';

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
  assert.equal(bySlot.out.text, [
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
  assert.equal(bySlot.left.text, [
    '💫 30 Minutes Left to Enter the Walmart Prismatic Evolutions Draw!',
    LINK, ITEM, '#Pokemon #ad',
  ].join('\n\n'));
  assert.ok(!bySlot.left.text.includes('Tips for Success'));
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
  assert.equal(at('out'), '16:50');
  assert.equal(at('going_live'), '16:59');   // one minute before, not at the start
  assert.equal(at('left'), '17:30');
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
  assert.equal(at('out'), '11:50');
  assert.equal(at('going_live'), '11:59');
  assert.equal(at('left'), '12:30');
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
  // Two sets means at least two products: Walmart runs one draw per product,
  // so the fixture carries one item per set rather than one item for both.
  const multi = buildPosts({
    items: [
      { postName: 'Prismatic Evolutions Booster Bundle 2-Pack', priceDisplay: '$79.94' },
      { postName: '30th Anniversary Elite Trainer Box', priceDisplay: '$59.99' },
    ],
    sets: ['30th Anniversary', 'Prismatic Evolutions'], startsAt, endsAt,
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

// Walmart sometimes puts One Piece or sports cards through the same draw.
// They belong in the posts, but always after Pokemon and under a subheading.
const poke = (n, p) => ({ postName: n, priceDisplay: p, classification: 'pokemon' });
const op = (n, p) => ({ postName: n, priceDisplay: p, classification: 'onepiece' });
const sport = (n, p) => ({ postName: n, priceDisplay: p, classification: 'sports' });
const mtg = (n, p) => ({ postName: n, priceDisplay: p, classification: 'othertcg' });

const headline = (its, st) => buildPosts({
  items: its, sets: st, startsAt, endsAt,
}).find((p) => p.slot === 'announcement').text.split('\n')[0];

const body = (its, st) => buildPosts({
  items: its, sets: st, startsAt, endsAt,
}).find((p) => p.slot === 'announcement').text;

test('One Piece only gets its own named subheading', () => {
  const text = body([poke('Prismatic Evolutions Booster Bundle 2-Pack', '$79.94'), op('One Piece OP-11 Booster Box', '$95.88')], ['Prismatic Evolutions']);
  assert.ok(text.includes(
    '• Prismatic Evolutions Booster Bundle 2-Pack $79.94\n\nOne Piece TCG Draws\n• One Piece OP-11 Booster Box $95.88',
  ));
});

test('sports only gets the sports subheading', () => {
  const text = body([poke('30th Celebration Elite Trainer Box', '$59.99'), sport('2026 Topps Chrome Baseball Hobby Box', '$299.99')], ['30th Celebration']);
  assert.ok(text.includes('\n\nSports Card Draws\n• 2026 Topps Chrome Baseball Hobby Box $299.99'));
});

test('a mixture falls back to the generic subheading', () => {
  const text = body([poke('30th Celebration Elite Trainer Box', '$59.99'), op('One Piece OP-11 Booster Box', '$95.88'), sport('Topps Chrome Hobby Box', '$299.99')], ['30th Celebration']);
  assert.ok(text.includes('\n\nOther TCG Draws\n'));
  assert.ok(!text.includes('One Piece TCG Draws'));
});

test('a single other card game also uses the generic subheading', () => {
  const text = body([poke('30th Celebration Elite Trainer Box', '$59.99'), mtg('Magic Star Trek Collector Booster', '$44.99')], ['30th Celebration']);
  assert.ok(text.includes('\n\nOther TCG Draws\n• Magic Star Trek Collector Booster $44.99'));
});

test('Pokemon sets lead the headline and the other categories follow', () => {
  assert.equal(
    headline([poke('Prismatic Evolutions Booster Bundle 2-Pack', '$79.94'), op('One Piece OP-11 Booster Box', '$95.88')], ['Prismatic Evolutions']),
    '💫 New Prismatic Evolutions and One Piece TCG Walmart Draws Beginning 10/26 at 5PM EST / 2PM PST!',
  );
  assert.equal(
    headline(
      [poke('30th Anniversary ETB', '$59.99'), poke('Prismatic Evolutions Bundle', '$79.94'), op('One Piece OP-11 Booster Box', '$95.88'), sport('Topps Chrome Hobby Box', '$299.99')],
      ['Prismatic Evolutions', '30th Anniversary'],
    ),
    // Sports cards are in the item list but not the headline: naming them
    // spends the most valuable words in the post on what the audience came
    // for least.
    '💫 New 30th Anniversary, Prismatic Evolutions and One Piece TCG Walmart Draws Beginning 10/26 at 5PM EST / 2PM PST!',
  );
});

test('sports cards never reach the headline, even alone with Pokemon', () => {
  assert.equal(
    headline([poke('30th Celebration Poster Collection', '$29.99'), sport('Topps Bowman Football Value Box', '$39.99')], ['30th Celebration']),
    // Two products, so "Draws", even though only one thing is named.
    '💫 New 30th Celebration Walmart Draws Beginning 10/26 at 5PM EST / 2PM PST!',
  );
});

// One Pokemon set plus one other category is still more than one thing.
test('one set plus one other category makes the noun plural', () => {
  assert.match(
    headline([poke('Prismatic Evolutions Bundle', '$79.94'), op('One Piece OP-11 Booster Box', '$95.88')], ['Prismatic Evolutions']),
    /Walmart Draws Beginning/,
  );
});

test('a Pokemon only draw is unchanged by any of this', () => {
  assert.equal(
    headline([poke('Prismatic Evolutions Booster Bundle 2-Pack', '$79.94')], ['Prismatic Evolutions']),
    '💫 New Prismatic Evolutions Walmart Draw Beginning 10/26 at 5PM EST / 2PM PST!',
  );
  assert.ok(!body([poke('Prismatic Evolutions Booster Bundle 2-Pack', '$79.94')], ['Prismatic Evolutions']).includes('Draws\n•'));
});

test('the Discord post carries the same split', () => {
  const text = discordPost({
    items: [poke('30th Celebration Elite Trainer Box', '$59.99'), op('One Piece OP-11 Booster Box', '$95.88')],
    sets: ['30th Celebration'],
    startsAt,
  });
  assert.ok(text.includes('30th Celebration and One Piece TCG Draws on 10/26'));
  assert.ok(text.includes('\n\nOne Piece TCG Draws\n• One Piece OP-11 Booster Box $95.88'));
});

// The member facing Discord posts.
const ROLE = '<@&123456789>';
const dposts = buildDiscordPosts({
  items: [poke('Prismatic Evolutions Booster Bundle 2-Pack', '$79.94')],
  sets: ['Prismatic Evolutions'],
  startsAt,
  endsAt,
  role: ROLE,
});
const dBySlot = Object.fromEntries(dposts.map((p) => [p.slot, p]));

test('there are four member posts on the expected anchors', () => {
  assert.deepEqual(dposts.map((p) => p.slot), ['announcement', 'one_hour', 'going_live', 'ten_left']);
  const at = (slot) => dBySlot[slot].dueAt.setZone('America/New_York').toFormat('HH:mm:ss');
  assert.equal(dBySlot.announcement.dueAt, null);
  assert.equal(at('one_hour'), '16:00:00');
  // On the hour exactly, not a minute early like the tweet.
  assert.equal(at('going_live'), '17:00:00');
  // Ten before the close, anchored to the close rather than the open.
  assert.equal(at('ten_left'), '17:50:00');
});

// A bot sending the literal text "@PokeFinder+" notifies nobody. Only the
// <@&id> form pings, so every post has to carry it.
test('every member post carries the role mention in pingable form', () => {
  for (const p of dposts) {
    assert.ok(p.text.includes(ROLE), `${p.slot} is missing the role mention`);
    assert.ok(!p.text.includes('@PokeFinder+'), `${p.slot} uses the plain text mention, which does not ping`);
  }
});

test('member posts count down from the right end of the window', () => {
  const start = Math.floor(startsAt.toSeconds());
  const end = Math.floor(endsAt.toSeconds());
  assert.ok(dBySlot.one_hour.text.includes(`<t:${start}:F>`));
  assert.ok(dBySlot.going_live.text.includes(`<t:${end}:F>`));
  assert.ok(dBySlot.ten_left.text.includes(`<t:${end}:R>`));
});

test('member posts use the Discord link, never the tweet one', () => {
  for (const p of dposts) {
    assert.ok(p.text.includes('howl.link/swe1iqp31stef'), `${p.slot} is missing the Discord draw link`);
    assert.ok(!p.text.includes('r5frrzi6qe8hx'), `${p.slot} is using the tweet link`);
  }
});

test('the one hour and going live posts carry the tips block', () => {
  assert.ok(dBySlot.one_hour.text.includes('**Tips for Success:**'));
  assert.ok(dBySlot.going_live.text.includes('**Tips for Success:**'));
  assert.ok(!dBySlot.announcement.text.includes('Tips for Success'));
  assert.ok(!dBySlot.ten_left.text.includes('Tips for Success'));
});

test('member posts carry the other TCG split too', () => {
  const mixed = buildDiscordPosts({
    items: [poke('30th Celebration Elite Trainer Box', '$59.99'), op('One Piece OP-11 Booster Box', '$95.88')],
    sets: ['30th Celebration'], startsAt, endsAt, role: ROLE,
  });
  assert.ok(mixed[0].text.includes('\n\nOne Piece TCG Draws\n• One Piece OP-11 Booster Box $95.88'));
  assert.ok(mixed[0].text.includes('30th Celebration and One Piece TCG Draws'));
});

test('every member post fits inside a Discord message', () => {
  const big = Array.from({ length: 8 }, (_, i) => poke(`A Fairly Long Product Name Number ${i + 1}`, '$199.99'));
  for (const p of buildDiscordPosts({ items: big, sets: ['30th Anniversary', 'Prismatic Evolutions'], startsAt, endsAt, role: ROLE })) {
    assert.ok(p.text.length < 1990, `${p.slot} is ${p.text.length} characters`);
  }
});

import { orderedPokemon, setRank, orderedSets } from '../src/copy.js';

// The list used to run in monitor arrival order while the headline was
// sorted, so a draw could announce 30th Celebration and then list it third.
test('30th Celebration leads the product list however the items arrive', () => {
  const items = [
    { ...poke('Prismatic Evolutions Booster Bundle', '$79.94'), set: 'Prismatic Evolutions' },
    { ...poke('Ascended Heroes Elite Trainer Box', '$49.99'), set: 'Ascended Heroes' },
    { ...poke('30th Celebration Elite Trainer Box', '$59.99'), set: '30th Celebration' },
  ];
  assert.deepEqual(orderedPokemon(items).map((i) => i.set),
    ['30th Celebration', 'Prismatic Evolutions', 'Ascended Heroes']);
  // Two sets of equal rank stay in arrival order and stay grouped; product
  // shape only reorders within a set.

  const text = buildPosts({
    items, sets: ['Prismatic Evolutions', 'Ascended Heroes', '30th Celebration'],
    startsAt, endsAt,
  })[0].text;
  assert.ok(text.indexOf('30th Celebration Elite Trainer Box')
    < text.indexOf('Prismatic Evolutions Booster Bundle'));
});

test('30th Celebration outranks 30th Anniversary, and both outrank the rest', () => {
  assert.ok(setRank('30th Celebration') < setRank('30th Anniversary'));
  assert.ok(setRank('30th Anniversary') < setRank('Prismatic Evolutions'));
  assert.deepEqual(
    orderedSets(['Prismatic Evolutions', '30th Anniversary', '30th Celebration']),
    ['30th Celebration', '30th Anniversary', 'Prismatic Evolutions'],
  );
});

test('two items of the same set and shape keep their arrival order', () => {
  const items = [
    { ...poke('30th Celebration Sylveon ex Box', '$21.99'), set: '30th Celebration' },
    { ...poke('30th Celebration Greninja ex Box', '$21.99'), set: '30th Celebration' },
  ];
  assert.deepEqual(orderedPokemon(items).map((i) => i.postName),
    ['30th Celebration Sylveon ex Box', '30th Celebration Greninja ex Box']);
});

// Two sets of equal rank must not interleave just because one has a bigger
// product in it.
test('sets stay grouped, product shape only reorders inside a set', () => {
  const items = [
    { ...poke('Prismatic Evolutions Booster Bundle', '$79.94'), set: 'Prismatic Evolutions' },
    { ...poke('Ascended Heroes Elite Trainer Box', '$49.99'), set: 'Ascended Heroes' },
    { ...poke('Prismatic Evolutions Elite Trainer Box', '$49.99'), set: 'Prismatic Evolutions' },
  ];
  assert.deepEqual(orderedPokemon(items).map((i) => i.postName), [
    'Prismatic Evolutions Elite Trainer Box',
    'Prismatic Evolutions Booster Bundle',
    'Ascended Heroes Elite Trainer Box',
  ]);
});

test('an item whose set the naming step could not place sorts last, not first', () => {
  const items = [
    { ...poke('Mystery Product', '$9.99'), set: null },
    { ...poke('30th Celebration Elite Trainer Box', '$59.99'), set: '30th Celebration' },
  ];
  assert.deepEqual(orderedPokemon(items).map((i) => i.postName),
    ['30th Celebration Elite Trainer Box', 'Mystery Product']);
});

import { productRank } from '../src/copy.js';

// Inside one set: premium collections, then sealed product by descending size.
test('products inside a set run premium, box, ETB, bundle, blister', () => {
  const names = [
    '30th Celebration 3-Pack Blister',
    '30th Celebration Booster Bundle',
    '30th Celebration Elite Trainer Box',
    '30th Celebration Booster Box',
    '30th Celebration Ultra Premium Collection',
  ];
  const items = names.map((n) => ({ ...poke(n, '$9.99'), set: '30th Celebration' }));
  assert.deepEqual(orderedPokemon(items).map((i) => i.postName), [
    '30th Celebration Ultra Premium Collection',
    '30th Celebration Booster Box',
    '30th Celebration Elite Trainer Box',
    '30th Celebration Booster Bundle',
    '30th Celebration 3-Pack Blister',
  ]);
});

test('Super Premium ranks with Ultra Premium, and the abbreviations count', () => {
  assert.equal(productRank('30th Celebration Super Premium Collection'), 0);
  assert.equal(productRank('Mega Evolution UPC'), 0);
  assert.equal(productRank('Destined Rivals ETB'), 2);
  assert.equal(productRank('Delta Reign Booster Display Box'), 1);
  // A Booster Bundle is not a Booster Box.
  assert.ok(productRank('Booster Bundle') > productRank('Booster Box'));
  // Anything unrecognised sorts after the named shapes, not before.
  assert.ok(productRank('Sylveon ex Box') > productRank('3-Pack Blister'));
});

// Set still beats product shape: a Celebration blister leads an Ascended UPC.
test('the set outranks the product shape', () => {
  const items = [
    { ...poke('Ascended Heroes Ultra Premium Collection', '$119.99'), set: 'Ascended Heroes' },
    { ...poke('30th Celebration 3-Pack Blister', '$12.99'), set: '30th Celebration' },
  ];
  assert.deepEqual(orderedPokemon(items).map((i) => i.set), ['30th Celebration', 'Ascended Heroes']);
});

// Walmart hyphenates. "Ultra-Premium Collection-Day and Night" is a real title.
test('hyphenated product names rank the same as spaced ones', () => {
  assert.equal(productRank('30th Celebration Ultra-Premium Collection-Day and Night'), 0);
  assert.equal(productRank('Mega Evolution Delta Reign Elite-Trainer-Box'), 2);
  assert.equal(productRank('Delta Reign Booster-Box'), 1);
  // "Ditto Premium Collection" is not an Ultra or Super Premium.
  assert.ok(productRank('30th Celebration Ditto Premium Collection') > 0);
});

import { SCHEDULES, orderedItems } from '../src/copy.js';

// Both accounts carry every draw, so identical times mean anyone following
// both sees the same tweet twice at the same minute.
test('CollectFinder runs its own reminder intervals', () => {
  const args = { items: [poke('30th Celebration ETB', '$59.99')], sets: ['30th Celebration'], startsAt, endsAt };
  const at = (posts, slot) => {
    const p = posts.find((x) => x.slot === slot);
    return p.dueAt ? p.dueAt.setZone('America/New_York').toFormat('HH:mm') : 'instant';
  };
  const pf = buildPosts({ ...args, variant: 'default' });
  const cf = buildPosts({ ...args, variant: 'collectfinder' });

  assert.equal(at(pf, 'announcement'), 'instant');
  assert.equal(at(cf, 'announcement'), 'instant');
  assert.equal(at(pf, 'morning'), '09:00');
  assert.equal(at(cf, 'morning'), '11:30');
  assert.equal(at(pf, 'out'), '16:50');
  assert.equal(at(cf, 'out'), '16:30');
  assert.equal(at(pf, 'left'), '17:30');
  assert.equal(at(cf, 'left'), '17:45');
  assert.equal(at(pf, 'over'), '18:00');
  assert.equal(at(cf, 'over'), '18:15');
  // The one moment that must not move.
  assert.equal(at(pf, 'going_live'), at(cf, 'going_live'));
});

// The interval is in the sentence as well as the clock, so they cannot drift.
test('the reminder wording matches the interval it is sent at', () => {
  const args = { items: [poke('30th Celebration ETB', '$59.99')], sets: ['30th Celebration'], startsAt, endsAt };
  const text = (posts, slot) => posts.find((x) => x.slot === slot).text.split('\n')[0];
  const pf = buildPosts({ ...args, variant: 'default' });
  const cf = buildPosts({ ...args, variant: 'collectfinder' });
  assert.match(text(pf, 'out'), /Going Live in 10 Minutes!$/);
  assert.match(text(cf, 'out'), /Going Live in 30 Minutes!$/);
  assert.match(text(pf, 'left'), /^💫 30 Minutes Left to Enter/);
  assert.match(text(cf, 'left'), /^💫 15 Minutes Left to Enter/);
  for (const [variant, plan] of Object.entries(SCHEDULES)) {
    const posts = buildPosts({ ...args, variant });
    assert.ok(text(posts, 'out').includes(`${plan.outMinutes} Minutes`), `${variant} out`);
    assert.ok(text(posts, 'left').includes(`${plan.leftMinutes} Minutes`), `${variant} left`);
  }
});

// The graphic is filled from this list too, so the grid matches the text.
test('orderedItems puts Pokemon first in set order, then the other games', () => {
  const items = [
    op('One Piece OP-11 Booster Box', '$95.88'),
    { ...poke('Prismatic Evolutions Booster Bundle', '$79.94'), set: 'Prismatic Evolutions' },
    { ...poke('30th Celebration Booster Bundle', '$26.99'), set: '30th Celebration' },
    { ...poke('30th Celebration Ultra-Premium Collection', '$224.97'), set: '30th Celebration' },
  ];
  assert.deepEqual(orderedItems(items).map((i) => i.postName), [
    '30th Celebration Ultra-Premium Collection',
    '30th Celebration Booster Bundle',
    'Prismatic Evolutions Booster Bundle',
    'One Piece OP-11 Booster Box',
  ]);
});
