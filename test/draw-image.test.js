import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { headingFor, templateFor, SLOT_ASPECT, MAX_ITEMS, TEMPLATES } from '../src/draw-image.js';

const et = (iso) => DateTime.fromISO(iso, { zone: 'America/New_York' });

test('heading matches the hand built format', () => {
  assert.equal(
    headingFor(et('2026-10-26T17:00')),
    'Drawing Starts October 26th\n5PM EST / 2PM PST',
  );
});

test('heading drops the minutes only when they are zero', () => {
  assert.equal(headingFor(et('2026-10-07T12:30')), 'Drawing Starts October 7th\n12:30PM EST / 9:30AM PST');
});

test('ordinals follow English rules, including the teens', () => {
  const day = (d) => headingFor(et(`2026-11-${String(d).padStart(2, '0')}T17:00`)).split('\n')[0];
  assert.equal(day(1), 'Drawing Starts November 1st');
  assert.equal(day(2), 'Drawing Starts November 2nd');
  assert.equal(day(3), 'Drawing Starts November 3rd');
  assert.equal(day(11), 'Drawing Starts November 11th');
  assert.equal(day(12), 'Drawing Starts November 12th');
  assert.equal(day(13), 'Drawing Starts November 13th');
  assert.equal(day(21), 'Drawing Starts November 21st');
  assert.equal(day(30), 'Drawing Starts November 30th');
});

// The labels are written EST and PST all year, but the conversion is real, so
// a draw during daylight saving still shows the right wall clock times.
test('a summer draw still reads three hours apart', () => {
  assert.equal(headingFor(et('2026-07-15T17:00')), 'Drawing Starts July 15th\n5PM EST / 2PM PST');
});

test('midnight and noon do not come out as 0', () => {
  assert.match(headingFor(et('2026-10-26T00:00')), /12AM EST/);
  assert.match(headingFor(et('2026-10-26T12:00')), /12PM EST/);
});

test('every count from one to the maximum has a template and a frame shape', () => {
  for (let n = 1; n <= MAX_ITEMS; n++) {
    assert.ok(templateFor(n), `no template for ${n} items`);
    assert.ok(SLOT_ASPECT[n] > 0, `no slot aspect for ${n} items`);
  }
});

test('templates are distinct, so two counts cannot share a layout', () => {
  const ids = Object.values(TEMPLATES);
  assert.equal(new Set(ids).size, ids.length);
});

test('a count with no template is reported rather than guessed at', () => {
  assert.equal(templateFor(MAX_ITEMS + 1), null);
  assert.equal(templateFor(0), null);
});
