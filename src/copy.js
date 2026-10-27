/**
 * The post copy.
 *
 * Every string here is taken verbatim from the draw sets HK has already
 * published. The wording is settled and is not to be improved on: this module
 * only substitutes the set names, the date, the times and the item list.
 */

export const DRAW_LINK_TWEETS = 'https://howl.link/r5frrzi6qe8hx';
export const DRAW_LINK_DISCORD = 'https://howl.link/swe1iqp31stef';
export const WINS_LINK = 'https://buff.ly/xswHYG8';

export const TIPS = [
  'Tips for Success:',
  '• Save your delivery address and default credit or debit card on your Walmart account before entering',
  '• PayPal does not work, so a credit or debit card must be saved',
  '• If your entry gets rejected, remove and re-enter your address in settings and set it as default',
  '• Entries stay open for 1 hour and the site slows down, so there is no rush',
].join('\n');

export const BOOKMARK = "🛎️ Bookmark & Follow, We'll Post When The Draw Goes Live! We'll Also Post Any New Draws That Get Added!";

const HASHTAGS = '#Pokemon #ad';

const clock = (dt) => {
  const h = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const suffix = dt.hour < 12 ? 'AM' : 'PM';
  return dt.minute === 0 ? `${h}${suffix}` : `${h}:${dt.toFormat('mm')}${suffix}`;
};

/** "5PM EST / 2PM PST" */
export function timeLabel(startsAt) {
  const et = startsAt.setZone('America/New_York');
  const pt = startsAt.setZone('America/Los_Angeles');
  return `${clock(et)} EST / ${clock(pt)} PST`;
}

/** "10/26", the short form the announcement uses. */
export const shortDate = (startsAt) => startsAt.setZone('America/New_York').toFormat('M/d');

/**
 * The set names, 30th Anniversary always first.
 *
 * A draw covering more than one set names them all, joined the way a person
 * would write them rather than with commas throughout.
 */
export function setsLabel(sets) {
  const ordered = [...sets].sort((a, b) => {
    const rank = (s) => (/30th/i.test(s) ? 0 : 1);
    return rank(a) - rank(b) || sets.indexOf(a) - sets.indexOf(b);
  });
  if (ordered.length === 1) return ordered[0];
  if (ordered.length === 2) return `${ordered[0]} and ${ordered[1]}`;
  return `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}`;
}

/** "• Prismatic Evolutions Booster Bundle 2-Pack $79.94" per item. */
export const itemLines = (items) => items.map((i) => `• ${i.postName} ${i.priceDisplay}`).join('\n');

const join = (...blocks) => blocks.filter(Boolean).join('\n\n');

/**
 * The seven posts for one draw day.
 *
 * `draw` is the word Draw or Draws: singular when the run covers one set, plural
 * when it covers several, matching how HK writes them.
 */
export function buildPosts({ items, sets, startsAt, endsAt }) {
  const label = setsLabel(sets);
  const plural = sets.length > 1;
  const noun = plural ? 'Draws' : 'Draw';
  const lines = itemLines(items);
  const when = timeLabel(startsAt);
  const link = `Enter Draw Here: ${DRAW_LINK_TWEETS}`;

  const et = startsAt.setZone('America/New_York');

  return [
    {
      slot: 'announcement',
      dueAt: null,
      text: join(
        `💫 New ${label} Walmart ${noun} Beginning ${shortDate(startsAt)} at ${when}!`,
        link, lines, BOOKMARK, HASHTAGS,
      ),
    },
    {
      slot: 'morning',
      dueAt: et.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }),
      text: join(
        `💫 Reminder! ${label} Walmart ${noun} Going Live Today at ${when}!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      slot: 'ten_minutes',
      dueAt: et.minus({ minutes: 10 }),
      text: join(
        `💫 Reminder: ${label} Walmart ${noun} Going Live in 10 Minutes!`,
        link, lines, TIPS, BOOKMARK, HASHTAGS,
      ),
    },
    {
      // One minute before the draw opens, not at the start time.
      slot: 'going_live',
      dueAt: et.minus({ minutes: 1 }),
      text: join(
        `💫 Walmart ${label} ${noun} Going Live! Entries Accepted for 1 Hour!`,
        link, lines, TIPS, HASHTAGS,
      ),
    },
    {
      slot: 'thirty_left',
      dueAt: et.plus({ minutes: 30 }),
      text: join(
        `💫 30 Minutes Left to Enter the Walmart ${label} ${noun}!`,
        link, lines, HASHTAGS,
      ),
    },
    {
      // Carries the image but no link, so it ends at #Pokemon with no #ad.
      slot: 'over',
      dueAt: endsAt.setZone('America/New_York'),
      text: join(
        "💫 Today's Walmart Draw is now over! We will post as soon as wins start going out!",
        "Follow & Turn Notifications On! We'll post the next draws as soon as they're announced!",
        '#Pokemon',
      ),
    },
  ];
}

/**
 * The wins post. A draft only, never scheduled, and it carries no image:
 * HK sends it by hand once wins actually start landing.
 */
export const winsPost = () => join(
  "✨️Wins from Today's Walmart Draws Are Starting to Go Out! Keep an Eye on Your Emails! "
  + 'Wins Likely To Go Out Over the Next Few Hours!',
  `Check Here: ${WINS_LINK}`,
  HASHTAGS,
);

/** Alt text for the attached draw image. */
export const altTextFor = ({ items, startsAt }) => {
  const et = startsAt.setZone('America/New_York');
  return `${items.map((i) => i.postName).join(', ')} Walmart draw starting `
    + `${et.toFormat('LLLL d')} at ${clock(et)} EST`;
};

/** The Discord post for HK's server. Returned as text for him to paste. */
export function discordPost({ items, sets, startsAt }) {
  const label = setsLabel(sets);
  const noun = sets.length > 1 ? 'Draws' : 'Draw';
  const epoch = Math.floor(startsAt.toSeconds());
  return [
    `# New Walmart Draws Beginning ${shortDate(startsAt)} at ${timeLabel(startsAt)}`,
    '',
    `**${label} ${noun} on ${shortDate(startsAt)} at ${timeLabel(startsAt)}: `
    + `<t:${epoch}:F> (<t:${epoch}:R>)** @PokeFinder+`,
    '',
    '**Items for Upcoming Draw:**',
    itemLines(items),
    `# Draw Link: [Walmart Collectibles Draw](${DRAW_LINK_DISCORD})`,
  ].join('\n');
}
