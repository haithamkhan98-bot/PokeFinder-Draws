import test from 'node:test';
import assert from 'node:assert/strict';
import { targetUrl, readQueueGated, looksWalled, probeListing, formatProbe } from '../src/target.js';

test('targetUrl uses the PokeFinder slug form, not Target\'s own', () => {
  assert.equal(targetUrl('1011407490'), 'https://www.target.com/p/PokeFinder/A-1011407490');
  assert.equal(targetUrl(' 1011407490 '), 'https://www.target.com/p/PokeFinder/A-1011407490');
});

test('readQueueGated finds the flag wherever it sits', () => {
  assert.equal(readQueueGated('{"fast_selling":{"queue_gated":true}}'), true);
  assert.equal(readQueueGated('..."queue_gated": false ...'), false);
  // Absent is null, which is NOT the same as false: one means Target moved the
  // flag, the other means the item is no longer in a drawing.
  assert.equal(readQueueGated('<html>a product page</html>'), null);
  assert.equal(readQueueGated(null), null);
});

test('looksWalled spots a block page', () => {
  assert.ok(looksWalled('<div>Press &amp; Hold to confirm you are a human</div>'));
  assert.ok(looksWalled('<script src="/px-captcha.js">'));
  assert.ok(looksWalled('Access Denied'));
  assert.equal(looksWalled('<html>Pokémon Trading Card Game</html>'), false);
});

test('probeListing reports a served page', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, url: 'https://www.target.com/p/x/-/A-123',
    text: async () => '<html><script id="__NEXT_DATA__">{"queue_gated":true}</script></html>',
  });
  const r = await probeListing('123', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.queueGated, true);
  assert.equal(r.hasNextData, true);
  assert.equal(r.walled, false);
  assert.match(formatProbe(r), /SERVED, queue_gated = true/);
});

test('probeListing reports a bot wall rather than calling it a product page', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, url: 'x', text: async () => 'Please Press & Hold',
  });
  const r = await probeListing('123', { fetchImpl });
  assert.equal(r.walled, true);
  assert.match(formatProbe(r), /BLOCKED/);
});

test('probeListing never throws', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await probeListing('123', { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
  assert.match(formatProbe(r), /FAILED: ECONNREFUSED/);
});

test('a 403 reads as refused, not as a missing flag', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, url: 'x', text: async () => 'nope' });
  const r = await probeListing('123', { fetchImpl });
  assert.match(formatProbe(r), /REFUSED: HTTP 403/);
});
