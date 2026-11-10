import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseLinkSheet, loadAffiliateLinks, forgetSheet, summariseSheet, skuKey } from '../src/sheet.js';
import { resolveLink } from '../src/parse.js';

// The Walmart tab's real shape: Set only on the first row of each block, a
// blank separator row between blocks, and some cells with no link yet.
const CSV = [
  'Set,Product,SKU,Walmart Link,Affiliate Link',
  'Chaos Rising,ETB,19988614228,https://www.walmart.com/ip/PokeFinder/19988614228,https://mavely.app.link/cSaCZoEEi3b',
  ',Booster Box,196214154186,https://www.walmart.com/ip/PokeFinder/196214154186,https://mavely.app.link/UdAxnzJRl4b',
  ',Mega Greninja ex Premium Collection,19994265476,https://www.walmart.com/ip/PokeFinder/19994265476,',
  ',,,,',
  'Perfect Order,ETB,19402160990,https://www.walmart.com/ip/PokeFinder/19402160990,https://mavely.app.link/tZKSNEhTN1b',
].join('\n');

test('a quoted comma in a product name does not split the row', () => {
  const rows = parseCsv('Set,Product,SKU\nX,"Booster Box, Case of 6",123');
  assert.deepEqual(rows[1], ['X', 'Booster Box, Case of 6', '123']);
});

test('doubled quotes inside a quoted field come back as one quote', () => {
  const rows = parseCsv('A\n"He said ""hi"""');
  assert.deepEqual(rows[1], ['He said "hi"']);
});

test('the Set column is carried down the block', () => {
  const map = parseLinkSheet(CSV);
  // Reading Set per row is how two SKUs once got reported as belonging to no
  // set at all.
  assert.equal(map.get('196214154186').set, 'Chaos Rising');
  assert.equal(map.get('19402160990').set, 'Perfect Order');
});

test('an empty affiliate cell is null, not an empty string', () => {
  const map = parseLinkSheet(CSV);
  assert.equal(map.get('19994265476').affiliate, null);
  assert.equal(map.get('19988614228').affiliate, 'https://mavely.app.link/cSaCZoEEi3b');
});

test('the AFFILIATE LINK NEEDED placeholder is not treated as a link', () => {
  const map = parseLinkSheet('Set,Product,SKU,Link,Affiliate Link\nX,Y,123,z,[AFFILIATE LINK NEEDED]');
  // Posting the placeholder as a URL would be worse than posting none.
  assert.equal(map.get('123').affiliate, null);
});

test('blank separator rows are skipped rather than becoming empty entries', () => {
  assert.equal(parseLinkSheet(CSV).size, 4);
});

test('a missing SKU or affiliate column throws rather than returning nothing', () => {
  // An empty map is indistinguishable from "no links known" and would quietly
  // post plain URLs for everything.
  assert.throws(() => parseLinkSheet('Set,Product,Link\nX,Y,z'), /no SKU column/);
  assert.throws(() => parseLinkSheet('Set,Product,SKU\nX,Y,123'), /no Affiliate Link column/);
});

test('column headers are matched loosely, so a rename does not break it', () => {
  const map = parseLinkSheet('Set,Product,SKU,Walmart Link,Affiliate Links\nX,Y,123,z,https://mavely.app.link/q');
  assert.equal(map.get('123').affiliate, 'https://mavely.app.link/q');
});

test('SKUs are keyed as digits, however the sheet stores them', () => {
  assert.equal(skuKey(' 196214154186 '), '196214154186');
  assert.equal(skuKey(196214154186), '196214154186');
});

test('an embed affiliate link beats the sheet, which beats the plain fallback', () => {
  const sheet = parseLinkSheet(CSV);
  assert.deepEqual(
    resolveLink({ sourceUrl: 'https://howl.link/fromembed', pid: '19988614228', sheet }),
    { link: 'https://howl.link/fromembed', affiliate: true },
  );
  const fromSheet = resolveLink({ sourceUrl: null, pid: '19988614228', sheet });
  assert.equal(fromSheet.link, 'https://mavely.app.link/cSaCZoEEi3b');
  assert.equal(fromSheet.fromSheet, true);
  // No link in the sheet means the behaviour before the sheet existed.
  assert.equal(
    resolveLink({ sourceUrl: null, pid: '19994265476', sheet }).link,
    'https://www.walmart.com/ip/PokeFinder/19994265476',
  );
});

test('no sheet at all behaves exactly as before', () => {
  assert.deepEqual(
    resolveLink({ sourceUrl: null, pid: '123' }),
    { link: 'https://www.walmart.com/ip/PokeFinder/123', affiliate: false },
  );
});

test('the sheet is cached, so ten items in a drop are one fetch', async () => {
  forgetSheet();
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return { ok: true, text: async () => CSV }; };
  const opts = { url: 'https://sheet/csv', fetchImpl, now: () => 1000 };
  await loadAffiliateLinks(opts);
  await loadAffiliateLinks(opts);
  assert.equal(fetches, 1);
  // Past the TTL it refetches.
  await loadAffiliateLinks({ ...opts, now: () => 1000 + 6 * 60_000 });
  assert.equal(fetches, 2);
});

test('a failed refresh serves the last good copy rather than nothing', async () => {
  forgetSheet();
  let ok = true;
  const fetchImpl = async () => {
    if (!ok) throw new Error('network down');
    return { ok: true, text: async () => CSV };
  };
  await loadAffiliateLinks({ url: 'https://sheet/csv', fetchImpl, now: () => 0 });
  ok = false;
  // A drop with slightly stale links beats a drop with none.
  const map = await loadAffiliateLinks({ url: 'https://sheet/csv', fetchImpl, now: () => 9e6 });
  assert.equal(map.get('19988614228').affiliate, 'https://mavely.app.link/cSaCZoEEi3b');
});

test('an unpublished sheet returning an HTML page is caught, not parsed', async () => {
  forgetSheet();
  const fetchImpl = async () => ({ ok: true, text: async () => '<!DOCTYPE html><html>Sorry</html>' });
  await assert.rejects(
    loadAffiliateLinks({ url: 'https://sheet/csv', fetchImpl, now: () => 0 }),
    /unpublished/,
  );
});

test('no URL configured returns null rather than throwing', async () => {
  forgetSheet();
  assert.equal(await loadAffiliateLinks({ url: undefined }), null);
  assert.match(summariseSheet(null), /no sheet configured/);
});

test('the summary counts how many SKUs still need a link', () => {
  assert.equal(summariseSheet(parseLinkSheet(CSV)), 'sheet: 4 SKUs, 3 with affiliate links');
});

import { missingLinks, missingLinksAlert, missingFingerprint } from '../src/sheet.js';

const MISSING = parseLinkSheet([
  'Set,Product,SKU,Walmart Link,Affiliate Link',
  'Chaos Rising,ETB,111,x,https://mavely.app.link/a',
  ',Mega Greninja ex Premium Collection,222,x,',
  'Perfect Order,Booster Bundle,333,x,[AFFILIATE LINK NEEDED]',
  ',3-Pack Blisters,444,x,',
].join('\n'));

test('the alert names every SKU without a link, grouped by set', () => {
  const body = missingLinksAlert(MISSING, { mention: '<@42>' });
  assert.match(body, /^<@42> \*\*3 Walmart SKUs still need an affiliate link\.\*\*/);
  // Grouped because that is how the sheet is laid out and how HK works
  // through it; a flat list means hunting for each row.
  assert.match(body, /\*\*Chaos Rising\*\*\nMega Greninja ex Premium Collection 222 </);
  assert.match(body, /\*\*Perfect Order\*\*\nBooster Bundle 333 <[^>]+>\n3-Pack Blisters 444 </);
  assert.doesNotMatch(body, /111/, 'SKUs that have a link are not listed');
});

test('the placeholder counts as missing, so it gets chased', () => {
  assert.ok(missingLinks(MISSING).some((r) => r.sku === '333'));
});

test('nothing missing sends nothing, rather than an all clear', () => {
  const complete = parseLinkSheet('Set,Product,SKU,Link,Affiliate Link\nX,Y,1,z,https://mavely.app.link/a');
  assert.equal(missingLinksAlert(complete), null);
});

test('without a user ID the alert still goes out, just unpinged', () => {
  assert.doesNotMatch(missingLinksAlert(MISSING, {}), /<@/);
  assert.match(missingLinksAlert(MISSING, {}), /^\*\*3 Walmart SKUs/);
});

test('one missing SKU reads as singular', () => {
  const one = parseLinkSheet('Set,Product,SKU,Link,Affiliate Link\nX,Y,1,z,');
  assert.match(missingLinksAlert(one), /1 Walmart SKU still needs an affiliate link/);
});

test('gaining a mention changes the fingerprint, so the ping actually lands', () => {
  // The first version hashed only the SKU list. Setting ALERT_USER_ID left the
  // list identical, so the send that would finally have pinged was suppressed
  // and the alert stayed silent forever.
  assert.notEqual(
    missingFingerprint(MISSING),
    missingFingerprint(MISSING, { mention: '<@42>' }),
  );
});

test('the same message twice fingerprints the same, so deploys stay quiet', () => {
  assert.equal(
    missingFingerprint(MISSING, { mention: '<@42>' }),
    missingFingerprint(MISSING, { mention: '<@42>' }),
  );
});

test('the fingerprint ignores row order, so a resort does not re-alert', () => {
  const reordered = parseLinkSheet([
    'Set,Product,SKU,Walmart Link,Affiliate Link',
    'Perfect Order,3-Pack Blisters,444,x,',
    ',Booster Bundle,333,x,[AFFILIATE LINK NEEDED]',
    'Chaos Rising,ETB,111,x,https://mavely.app.link/a',
    ',Mega Greninja ex Premium Collection,222,x,',
  ].join('\n'));
  assert.equal(missingFingerprint(MISSING), missingFingerprint(reordered));
});

test('the fingerprint changes when a link is filled in', () => {
  const fixed = parseLinkSheet([
    'Set,Product,SKU,Walmart Link,Affiliate Link',
    'Chaos Rising,ETB,111,x,https://mavely.app.link/a',
    ',Mega Greninja ex Premium Collection,222,x,https://mavely.app.link/b',
    'Perfect Order,Booster Bundle,333,x,[AFFILIATE LINK NEEDED]',
    ',3-Pack Blisters,444,x,',
  ].join('\n'));
  assert.notEqual(missingFingerprint(MISSING), missingFingerprint(fixed));
});

test('a complete sheet fingerprints as empty, so it never alerts', () => {
  const complete = parseLinkSheet('Set,Product,SKU,Link,Affiliate Link\nX,Y,1,z,https://mavely.app.link/a');
  assert.equal(missingFingerprint(complete), '');
});

import { splitAlert } from '../src/sheet.js';

const WITHLINKS = parseLinkSheet([
  'Set,Product,SKU,Walmart Link,Affiliate Link',
  'Chaos Rising,ETB,111,https://www.walmart.com/ip/PokeFinder/111,https://mavely.app.link/a',
  ',Mega Greninja ex Premium Collection,222,https://www.walmart.com/ip/PokeFinder/222,',
].join('\n'));

test('each missing item carries its link, from the sheet own column', () => {
  const body = missingLinksAlert(WITHLINKS);
  assert.match(body, /Mega Greninja ex Premium Collection 222 <https:\/\/www\.walmart\.com\/ip\/PokeFinder\/222>/);
});

test('links are wrapped so Discord does not render a preview per item', () => {
  // Eleven missing SKUs would otherwise bury the message under eleven embeds.
  const body = missingLinksAlert(WITHLINKS);
  for (const m of body.matchAll(/https?:\/\/\S+/g)) {
    const at = body.indexOf(m[0]);
    assert.equal(body[at - 1], '<', `unwrapped URL: ${m[0]}`);
  }
});

test('a row with no link in the sheet falls back to the PokeFinder form', () => {
  const noLink = parseLinkSheet('Set,Product,SKU,Walmart Link,Affiliate Link\nX,Y,999,,');
  assert.equal(noLink.get('999').link, 'https://www.walmart.com/ip/PokeFinder/999');
});

test('the sheet link is included when configured, and omitted when not', () => {
  assert.match(missingLinksAlert(WITHLINKS, { sheetUrl: 'https://docs.google.com/x' }), /Sheet: <https:\/\/docs\.google\.com\/x>/);
  assert.doesNotMatch(missingLinksAlert(WITHLINKS), /Sheet:/);
});

test('a long alert is split rather than truncated', () => {
  // alert() cuts at 1900 characters, which would drop the SKUs at the bottom,
  // the ones HK has not got to yet.
  const rows = ['Set,Product,SKU,Walmart Link,Affiliate Link'];
  for (let i = 0; i < 120; i += 1) {
    rows.push(`Set ${i},A Reasonably Long Product Name ${i},${1000000 + i},https://www.walmart.com/ip/PokeFinder/${1000000 + i},`);
  }
  const body = missingLinksAlert(parseLinkSheet(rows.join('\n')));
  assert.ok(body.length > 1900);
  const parts = splitAlert(body);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1900, `part was ${p.length}`);
  // Nothing is lost in the split.
  assert.ok(parts.join('\n\n').includes('1000119'));
});

test('a short alert stays one message', () => {
  assert.equal(splitAlert(missingLinksAlert(WITHLINKS)).length, 1);
  assert.deepEqual(splitAlert(null), []);
});

import { conflictAlert } from '../src/sheet.js';

const CLASH = parseLinkSheet([
  'Set,Product,SKU,Walmart Link,Affiliate Link',
  'Chaos Rising,Mega Greninja ex Premium Collection,19994265476,x,',
  'Miscellaneous,Lumiose City Mini Tin Display,19994265476,x,https://howl.link/bafn77d9yscwh',
].join('\n'));

const SAMENAME = parseLinkSheet([
  'Set,Product,SKU,Walmart Link,Affiliate Link',
  'Phantasmal Flames,3-Pack Booster,17818262325,x,https://mavely.app.link/e/abc',
  'Phantasmal Flames,3-Pack Blister,17818262325,x,https://mavely.app.link/e/abc',
].join('\n'));

test('a SKU on two rows with different products and different links is reported', () => {
  // The later row wins silently, so the earlier product inherits the later
  // one's link: buyers sent to the wrong item, revenue misattributed. Worse
  // than no link at all.
  assert.equal(CLASH.conflicts.length, 1);
  const body = conflictAlert(CLASH);
  assert.match(body, /SKU 19994265476/);
  assert.match(body, /Mega Greninja ex Premium Collection/);
  assert.match(body, /Lumiose City Mini Tin Display/);
  assert.match(body, /currently getting <https:\/\/howl\.link\/bafn77d9yscwh>/);
});

test('two names for one product sharing a link is not a conflict', () => {
  // Reporting this would be noise that trains HK to ignore the alert.
  assert.deepEqual(SAMENAME.conflicts, []);
  assert.equal(conflictAlert(SAMENAME), null);
});

test('a plain duplicate row is not a conflict either', () => {
  const dupe = parseLinkSheet([
    'Set,Product,SKU,Walmart Link,Affiliate Link',
    'X,Same Product,111,x,https://mavely.app.link/a',
    'X,Same Product,111,x,https://mavely.app.link/a',
  ].join('\n'));
  assert.deepEqual(dupe.conflicts, []);
});

test('the conflict alert carries the sheet link and the mention', () => {
  const body = conflictAlert(CLASH, { mention: '<@42>', sheetUrl: 'https://docs.google.com/x' });
  assert.match(body, /^<@42> /);
  assert.match(body, /Sheet: <https:\/\/docs\.google\.com\/x>/);
});

test('no conflicts sends nothing', () => {
  const clean = parseLinkSheet('Set,Product,SKU,Link,Affiliate Link\nX,Y,1,z,https://mavely.app.link/a');
  assert.equal(conflictAlert(clean), null);
});
