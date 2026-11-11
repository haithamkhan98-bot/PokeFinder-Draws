/**
 * US federal holidays.
 *
 * Walmart's queue and draw schedule shifts around them: the November 2026
 * queue moved from Wednesday the 11th to Thursday the 12th because the 11th
 * was Veterans Day, and nothing in the monitor embeds said so. The bot had
 * already dated the run to Wednesday from its own "next Wednesday" rule and
 * would have posted an announcement for a drop that was not happening.
 *
 * It cannot know the new date, since Walmart does not publish one anywhere the
 * bot can see. What it can do is notice that its assumed date is a holiday and
 * refuse to publish on it.
 *
 * The floating holidays are computed rather than listed, so this does not
 * quietly expire at the end of a hardcoded year.
 */

const nth = (year, month, weekday, n) => {
  // Luxon weekdays: 1 Monday through 7 Sunday.
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay() === 0 ? 7 : first.getUTCDay();
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const last = (year, month, weekday) => {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDate = new Date(Date.UTC(year, month - 1, days));
  const lastWeekday = lastDate.getUTCDay() === 0 ? 7 : lastDate.getUTCDay();
  const day = days - ((lastWeekday - weekday + 7) % 7);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const fixed = (year, month, day, name) => [
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, name,
];

/** Every federal holiday in a year, as ISO date to name. */
export function federalHolidays(year) {
  return new Map([
    fixed(year, 1, 1, "New Year's Day"),
    [nth(year, 1, 1, 3), 'Martin Luther King Jr. Day'],
    [nth(year, 2, 1, 3), "Washington's Birthday"],
    [last(year, 5, 1), 'Memorial Day'],
    fixed(year, 6, 19, 'Juneteenth'),
    fixed(year, 7, 4, 'Independence Day'),
    [nth(year, 9, 1, 1), 'Labor Day'],
    [nth(year, 10, 1, 2), 'Columbus Day'],
    fixed(year, 11, 11, 'Veterans Day'),
    [nth(year, 11, 4, 4), 'Thanksgiving Day'],
    fixed(year, 12, 25, 'Christmas Day'),
  ]);
}

/**
 * The holiday falling on an ISO date, or null.
 *
 * Deliberately does NOT apply the observed-holiday shift, where a Saturday
 * holiday is observed on the Friday before. Retail does not close for the
 * observance, and the thing being detected is whether Walmart is likely to
 * move a drop, not whether federal offices are shut.
 */
export function holidayOn(isoDate) {
  const year = Number(String(isoDate).slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return federalHolidays(year).get(String(isoDate)) ?? null;
}
