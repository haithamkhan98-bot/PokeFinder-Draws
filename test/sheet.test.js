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
