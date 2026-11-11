import test from 'node:test';
import assert from 'node:assert/strict';
import { holidayOn, federalHolidays } from '../src/holidays.js';

test('the holiday that moved a real drop is detected', () => {
  // Walmart moved the November 2026 queue from Wednesday the 11th to Thursday
  // the 12th, and said so nowhere the bot could see.
  assert.equal(holidayOn('2026-11-11'), 'Veterans Day');
  assert.equal(holidayOn('2026-11-12'), null);
});

test('floating holidays are computed, not hardcoded for one year', () => {
  assert.equal(holidayOn('2026-11-26'), 'Thanksgiving Day');  // 4th Thursday
  assert.equal(holidayOn('2027-11-25'), 'Thanksgiving Day');
  assert.equal(holidayOn('2026-01-19'), 'Martin Luther King Jr. Day'); // 3rd Monday
  assert.equal(holidayOn('2027-01-18'), 'Martin Luther King Jr. Day');
  assert.equal(holidayOn('2026-05-25'), 'Memorial Day');      // last Monday
  assert.equal(holidayOn('2027-05-31'), 'Memorial Day');
  assert.equal(holidayOn('2026-09-07'), 'Labor Day');         // 1st Monday
  assert.equal(holidayOn('2026-10-12'), 'Columbus Day');      // 2nd Monday
});

test('fixed holidays land on their date', () => {
  assert.equal(holidayOn('2026-01-01'), "New Year's Day");
  assert.equal(holidayOn('2026-06-19'), 'Juneteenth');
  assert.equal(holidayOn('2026-07-04'), 'Independence Day');
  assert.equal(holidayOn('2026-12-25'), 'Christmas Day');
});

test('every year has exactly eleven federal holidays', () => {
  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    assert.equal(federalHolidays(y).size, 11, `${y}`);
  }
});

test('the observed shift is deliberately not applied', () => {
  // 2027-07-04 is a Sunday, observed Monday the 5th by federal offices.
  // Retail does not close for the observance, and what is being detected is
  // whether Walmart is likely to move a drop, not whether offices are shut.
  assert.equal(holidayOn('2027-07-04'), 'Independence Day');
  assert.equal(holidayOn('2027-07-05'), null);
});

test('an ordinary Wednesday is not a holiday', () => {
  for (const d of ['2026-11-18', '2026-11-04', '2026-12-02']) {
    assert.equal(holidayOn(d), null, d);
  }
});

test('nonsense input returns null rather than throwing', () => {
  assert.equal(holidayOn(''), null);
  assert.equal(holidayOn(null), null);
  assert.equal(holidayOn('not-a-date'), null);
});
