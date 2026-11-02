import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { drawRedditPosts, queueRedditPosts, trimTitle, TITLE_MAX } from '../src/reddit-copy.js';
import { TIPS } from '../src/copy.js';

const et = (i) => DateTime.fromISO(i, { zone: 'America/New_York' });
const poke = (postName, priceDisplay) => ({ postName, priceDisplay, classification: 'pokemon' });
const op = (postName, priceDisplay) => ({ postName, priceDisplay, classification: 'onepiece' });

const drawArgs = {
  items: [poke('30th Celebration Elite Trainer Box', '$59.99'), op('One Piece OP-11 Booster Box', '$95.88')],
  sets: ['30th Celebration'],
  startsAt: et('2026-11-04T17:00'), endsAt: et('2026-11-04T18:00'), now: et('2026-11-03T20:31'),
};
const queueArgs = {
  items: [{ postName: 'Pokemon TCG Mega Evolution Elite Trainer Box', classification: 'pokemon', priceCents: 5999 }],
  dropAt: et('2026-11-04T21:00'), headline: 'Mega Evolution', now: et('2026-11-03T20:31'),
};

test('a draw makes two posts, both subs, the second 15 minutes before the open', () => {
  const posts = drawRedditPosts(drawArgs);
  assert.deepEqual(posts.map((p) => p.slot), ['announcement', 'going_live']);
  assert.equal(posts[0].dueAt, null);
  assert.equal(posts[1].dueAt.toFormat('ccc HH:mm'), 'Wed 16:45');
  for (const p of posts) assert.deepEqual(p.subs, ['PokeCollectors', 'TCGHub']);
});

test('a queue goes to TCGHub alone, mirroring CollectFinder', () => {
  for (const p of queueRedditPosts(queueArgs)) assert.deepEqual(p.subs, ['TCGHub']);
});

// Reddit titles cannot be edited, so nothing may say how long is left.
test('no title counts down', () => {
  const titles = [...drawRedditPosts(drawArgs), ...queueRedditPosts(queueArgs)].map((p) => p.title);
  for (const t of titles) {
    assert.ok(!/\b\d+\s*minutes?\b/i.test(t), `"${t}" counts down`);
    assert.ok(t.length <= TITLE_MAX, `"${t}" is over ${TITLE_MAX} chars`);
  }
});

// Emoji and hashtags are what make a Reddit post read as spam.
test('no emoji and no hashtags anywhere', () => {
  const all = [...drawRedditPosts(drawArgs), ...queueRedditPosts(queueArgs)];
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  for (const p of all) {
    for (const [what, s] of [['title', p.title], ['body', p.body]]) {
      assert.ok(!emoji.test(s), `${p.slot} ${what} contains an emoji`);
      assert.ok(!/(^|\s)#\w/.test(s), `${p.slot} ${what} contains a hashtag`);
    }
  }
});

// Tips belong on the go live post only. The announcement stays short.
test('only the going live post carries the tips block', () => {
  for (const build of [drawRedditPosts(drawArgs), queueRedditPosts(queueArgs)]) {
    const [announce, live] = build;
    assert.ok(!announce.body.includes('Tips for Success'), 'the announcement carries tips');
    assert.ok(live.body.includes('**Tips for Success**'), 'the go live post is missing tips');
  }
});

test('every post opens with the enter line and then the item list', () => {
  for (const p of [...drawRedditPosts(drawArgs), ...queueRedditPosts(queueArgs)]) {
    assert.match(p.body, /^Enter Here at .+ EST \/ .+ PST: \[Walmart Collectibles (Draw|Queue)\]\(https:\/\//);
    assert.ok(p.body.indexOf('Item List:') > 0);
  }
});

// HK asked for no disclosure line on Reddit.
test('no affiliate disclosure line', () => {
  for (const p of [...drawRedditPosts(drawArgs), ...queueRedditPosts(queueArgs)]) {
    assert.ok(!/affiliate/i.test(p.body), `${p.slot} still carries a disclosure`);
  }
});

// The Canva grid rides along with every post.
test('the image url is carried on both posts', () => {
  const posts = drawRedditPosts({ ...drawArgs, imageUrl: 'https://example.com/grid.png' });
  for (const p of posts) assert.equal(p.imageUrl, 'https://example.com/grid.png');
});

// The point of reusing copy.js is that HK's settled wording is not reworded.
// Only the bullet character changes.
test('the tips wording is carried over verbatim', () => {
  const body = drawRedditPosts(drawArgs)[1].body;
  for (const line of TIPS.split('\n').slice(1)) {
    const words = line.replace(/^•\s*/, '');
    assert.ok(body.includes(words), `tips line missing: ${words}`);
  }
  assert.ok(body.includes('**Tips for Success**'));
});

test('Pokemon leads the draw list and the other game gets its own heading', () => {
  const body = drawRedditPosts(drawArgs)[0].body;
  assert.ok(body.indexOf('30th Celebration Elite Trainer Box') < body.indexOf('**One Piece TCG Draws**'));
  assert.ok(body.includes('* 30th Celebration Elite Trainer Box $59.99'));
});

test('an overlong title is cut on a word boundary', () => {
  const t = trimTitle(`Walmart ${'Very Long Set Name '.repeat(30)}Draws`);
  assert.ok(t.length <= TITLE_MAX);
  assert.ok(!t.endsWith(' '));
  assert.ok(!/\bVer$|\bLon$/.test(t));
});
