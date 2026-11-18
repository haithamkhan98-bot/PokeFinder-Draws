import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  parseDrawClose, parseDrawCommand, parseItemLine, sheetName, resolveDrawItems, unresolved, closeFromEmbeds,
} from '../src/target-manual.js';
import { parseLinkSheet } from '../src/sheet.js';
import { readOgImage, readOgTitle } from '../src/target.js';
import { embedListing } from '../src/target-raffle.js';
import { buildRafflePosts, targetDiscordPosts, raffleHeadline } from '../src/target-copy.js';

const ET = 'America/New_York';
const now = DateTime.fromISO('2026-11-18T13:00', { zone: ET });
const at = (s) => DateTime.fromISO(s, { zone: ET }).toMillis();

test('the close time reads the ways HK types it, Eastern by default', () => {
  for (const t of ['Nov 19 11am', '11/19 11am', '11/19/2026 11:00am', 'Nov 19 at 11AM EST', '11am Nov 19', 'November 19th 11am']) {
    const r = parseDrawClose(t, { now });
    assert.ok(r.ok, `${t}: ${r.reason}`);
    assert.equal(r.closesAt.toMillis(), at('2026-11-19T11:00'), t);
  }
});

test('a named zone is honoured, Target\'s own wording included', () => {
  assert.equal(parseDrawClose('Nov 19 10am CT', { now }).closesAt.toMillis(), at('2026-11-19T11:00'));
  assert.equal(parseDrawClose('10am CT on Nov 19', { now }).closesAt.toMillis(), at('2026-11-19T11:00'));
});

test('a past, far off or unreadable close is refused with the reason', () => {
  assert.match(parseDrawClose('Nov 18 9am', { now }).reason ?? '', /month|days|passed/);
  assert.match(parseDrawClose('11/18/2026 9am', { now }).reason, /already passed/);
  assert.match(parseDrawClose('Feb 20 11am', { now }).reason, /more than 30 days/);
  assert.match(parseDrawClose('tomorrow morning', { now }).reason, /could not read/);
});

test('with no year, a date that has passed this year means next year', () => {
  const late = DateTime.fromISO('2026-12-30T12:00', { zone: ET });
  assert.equal(parseDrawClose('1/2 11am', { now: late }).closesAt.toFormat('yyyy-LL-dd'), '2027-01-02');
});

test('an item line takes a TCIN or Target URL, then a link and a name in any order', () => {
  assert.deepEqual(parseItemLine('1012663804'), { tcin: '1012663804', link: null, name: null });
  assert.deepEqual(
    parseItemLine('https://www.target.com/p/x/-/A-1012663804 https://howl.link/abc Ditto Premium Collection'),
    { tcin: '1012663804', link: 'https://howl.link/abc', name: 'Ditto Premium Collection' },
  );
  assert.deepEqual(parseItemLine('1012663804 Ditto Premium Collection https://howl.link/abc'),
    { tcin: '1012663804', link: 'https://howl.link/abc', name: 'Ditto Premium Collection' });
  assert.match(parseItemLine('ditto').error, /not a TCIN/);
});

test('the command: close time on the first line, an item per line', () => {
  const r = parseDrawCommand(' Nov 19 11am\n1012850570\n1012850572\n1012850570\n1012663804 Ditto Box', { now });
  assert.ok(r.ok);
  assert.deepEqual(r.items.map((i) => i.tcin), ['1012850570', '1012850572', '1012663804'], 'repeats dropped');
  assert.equal(r.items[2].name, 'Ditto Box');
});

test('the command also works on one line', () => {
  const r = parseDrawCommand(' 11/19 11am 1012850570 1012850572', { now });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.closesAt.toMillis(), at('2026-11-19T11:00'));
  assert.equal(r.items.length, 2);
});

test('the command collects every problem at once', () => {
  const r = parseDrawCommand(' whenever\nditto', { now });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Close time/.test(e)));
  assert.ok(r.errors.some((e) => /not a TCIN/.test(e)));
});

const SHEET = parseLinkSheet([
  'Set,Product,SKU,Target Link,Affiliate Link',
  '30th Celebration,Pokemon Day 2026 Collection,95082138,,https://howl.link/day26',
  ',Ultra Premium Collection Day,1012850570,https://www.target.com/p/PokeFinder/-/A-1012850570,https://howl.link/boad',
  ',Ultra Premium Collection Night,1012850572,https://www.target.com/p/PokeFinder/-/A-1012850572,https://howl.link/7up0',
  ',Ditto Premium Collection,1012663804,https://www.target.com/p/PokeFinder/-/A-1012663804,https://howl.link/lq2j',
  'Miscellaneous,Mega Forces Tin (Darkrai),1012944745,,',
].join('\n'), { retailer: 'target' });

test('the Target tab falls back to a Target link, not a Walmart one', () => {
  assert.equal(SHEET.get('95082138').link, 'https://www.target.com/p/PokeFinder/A-95082138');
  assert.equal(SHEET.get('1012944745').affiliate, null);
});

test('a sheet row becomes set plus product, and Miscellaneous is not a set', () => {
  assert.deepEqual(sheetName(SHEET.get('1012663804')), { name: '30th Celebration Ditto Premium Collection', set: '30th Celebration' });
  assert.deepEqual(sheetName(SHEET.get('1012944745')), { name: 'Mega Forces Tin (Darkrai)', set: null });
});

test('the Nov 19 draw resolves entirely from the sheet and posts with the product headline', async () => {
  const lines = parseDrawCommand(' Nov 19 11am\n1012850570\n1012850572\n1012663804', { now }).items;
  const items = await resolveDrawItems(lines, {
    sheet: SHEET,
    lastSeen: async (tcin) => ({ image_url: `https://img/${tcin}.png`, raw_title: 'raw' }),
  });
  assert.deepEqual(items.map((i) => i.link), ['https://howl.link/boad', 'https://howl.link/7up0', 'https://howl.link/lq2j']);
  assert.ok(items.every((i) => i.affiliate && i.image && i.sources.name === 'sheet'));
  assert.equal(raffleHeadline(items),
    '30th Celebration Ultra Premium Collection Day and Night and Ditto Premium Collection');

  const closesAt = DateTime.fromISO('2026-11-19T11:00', { zone: ET });
  const posts = buildRafflePosts({ items, now, closesAt, openedAt: now });
  assert.deepEqual(posts.map((p) => [p.slot, p.dueAt?.toFormat('LLL d h:mma') ?? 'now']),
    [['live', 'now'], ['night', 'Nov 18 10:00PM'], ['closing', 'Nov 19 10:00AM']]);
  assert.deepEqual(targetDiscordPosts({ items, now, closesAt }).map((p) => p.slot), ['live', 'closing'],
    'Discord gets the announcement and the hour warning only');
});

test('his own name and link beat the sheet', async () => {
  const [item] = await resolveDrawItems(
    [{ tcin: '1012663804', link: 'https://howl.link/mine', name: 'Ditto Box' }], { sheet: SHEET },
  );
  assert.equal(item.postName, 'Ditto Box');
  assert.equal(item.set, '30th Celebration', 'the set still comes from the sheet');
  assert.equal(item.link, 'https://howl.link/mine');
});

test('off the sheet, the monitor row, then an embed, then Target fill the gaps', async () => {
  const [a] = await resolveDrawItems([{ tcin: '111111111' }], {
    lastSeen: async () => ({ product_name: 'Mega Evolution Booster Bundle', set_name: 'Mega Evolution',
      link: 'https://howl.link/mon', affiliate: true, image_url: 'https://img/a.png', raw_title: 'raw' }),
  });
  assert.equal(a.postName, 'Mega Evolution Booster Bundle');
  assert.equal(a.link, 'https://howl.link/mon');

  let probed = 0;
  const [b] = await resolveDrawItems([{ tcin: '222222222' }], {
    embeds: new Map([['222222222', { rawTitle: 'Pokemon TCG: Thing', link: 'https://howl.link/zephyr-x' }]]),
    probe: async () => { probed += 1; return { image: 'https://target.scene7.com/b.jpg', title: null }; },
  });
  assert.equal(probed, 1, 'only fetched because the photo was missing');
  assert.equal(b.needsNaming, true, 'a raw title goes through the naming step');
  assert.equal(b.link, 'https://www.target.com/p/PokeFinder/A-222222222', 'someone else\'s link is not used');
  assert.equal(b.image, 'https://target.scene7.com/b.jpg');
});

test('an item found nowhere stops the command', async () => {
  const items = await resolveDrawItems([{ tcin: '333333333' }], { probe: async () => ({ title: null, image: null }) });
  assert.equal(unresolved(items).length, 1);
});

test('Target\'s photo and title are read off its meta tags', () => {
  const html = '<meta property="og:title" content="Pokémon TCG: Ditto Premium Collection : Target">'
    + '<meta content="https://target.scene7.com/is/image/Target/GUEST_1?wid=800&amp;hei=800" property="og:image">';
  assert.equal(readOgImage(html), 'https://target.scene7.com/is/image/Target/GUEST_1?wid=800&hei=800');
  assert.equal(readOgTitle(html), 'Pokémon TCG: Ditto Premium Collection');
  assert.equal(readOgImage('<html></html>'), null);
});

test('any Target monitor embed lends its listing, raffle or restock', () => {
  const l = embedListing({
    author: { name: 'Target Raffles' }, title: 'Ditto', url: 'https://howl.link/x',
    thumbnail: { url: 'https://img/x.jpg' }, fields: [{ name: 'Tcin', value: '1012663804' }],
  });
  assert.deepEqual(l, { tcin: '1012663804', rawTitle: 'Ditto', link: 'https://howl.link/x', image: 'https://img/x.jpg', closesAt: null });
  assert.equal(embedListing({ author: { name: 'Walmart Droplist' }, fields: [{ name: 'Tcin', value: '1' }] }), null);
});

test('with no time line, the command takes the close from the monitor\'s Drawing Date', async () => {
  const r = parseDrawCommand(' \n1012850570\n1012663804', { now });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.closesAt, null);

  const close = DateTime.fromSeconds(1795104000);
  const embeds = new Map(r.items.map((i) => [i.tcin, { closesAt: close }]));
  const items = await resolveDrawItems(r.items, { sheet: SHEET, embeds });
  const got = closeFromEmbeds(items, { now });
  assert.ok(got.ok);
  assert.equal(got.closesAt.toMillis(), at('2026-11-19T11:00'));
});

test('a close from the embeds is refused when one is missing or they disagree', () => {
  const a = { tcin: '1', closesAt: DateTime.fromSeconds(1795104000) };
  assert.match(closeFromEmbeds([a, { tcin: '2', closesAt: null }], { now }).reason, /no Drawing Date .* 2/);
  assert.match(closeFromEmbeds([a, { tcin: '2', closesAt: a.closesAt.plus({ hours: 1 }) }], { now }).reason, /different times/);
  assert.match(closeFromEmbeds([a], { now: a.closesAt.plus({ minutes: 1 }) }).reason, /closed/);
});
