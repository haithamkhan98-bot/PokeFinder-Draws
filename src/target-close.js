import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';

/**
 * A key for the close time route alone.
 *
 * Deliberately not SETUP_KEY. This one is pasted into a bookmark that lives in
 * a browser toolbar, syncs between machines and shows up in history, so it
 * leaks far more easily than a key read out of the Railway logs once. Keeping
 * it separate means a leak costs a stranger the ability to set a draw's close
 * time, not the ability to reauthorise Canva.
 */
export const closeKey = process.env.TARGET_CLOSE_KEY || randomBytes(12).toString('hex');

/**
 * Target writes its close times like "Enter by 10am CT on Nov 11".
 *
 * Note the zone is Target's, not the reader's: Target is a Minneapolis
 * company and states these in Central. Reading 10am CT as 10am Eastern would
 * put the closing reminder an hour late, every time.
 *
 * The zone is resolved through an IANA name rather than a fixed offset so
 * that Luxon applies the right one for that date. CT is UTC-5 in October and
 * UTC-6 in November, and these draws straddle the changeover.
 */
const ZONES = {
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
};
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseCloseText(text, { now = DateTime.now() } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  // "10am CT on Nov 11", and the reversed "Nov 11 at 10am CT".
  const a = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*([a-z]{2,3})\b[\s,]*(?:on|at)?[\s,]*([a-z]{3,9})\.?\s*(\d{1,2})\b/i);
  const b = t.match(/([a-z]{3,9})\.?\s*(\d{1,2})\b[\s,]*(?:at|by)?[\s,]*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*([a-z]{2,3})\b/i);

  let hour, minute, mer, zoneAbbr, monName, day;
  if (a) [, hour, minute, mer, zoneAbbr, monName, day] = a;
  else if (b) [, monName, day, hour, minute, mer, zoneAbbr] = b;
  else return null;

  const zone = ZONES[String(zoneAbbr).toLowerCase()];
  const month = MONTHS[String(monName).slice(0, 3).toLowerCase()];
  if (!zone || !month) return null;

  let h = Number(hour) % 12;
  if (String(mer).toLowerCase() === 'pm') h += 12;

  // Target omits the year. Take the reading that is not in the past, which is
  // the only one that can be meant for a draw that is currently open.
  for (const year of [now.year, now.year + 1]) {
    const dt = DateTime.fromObject(
      { year, month, day: Number(day), hour: h, minute: Number(minute ?? 0) },
      { zone },
    );
    if (dt.isValid && dt > now.minus({ days: 1 })) return dt;
  }
  return null;
}

/**
 * What the bookmarklet sent, as an instant.
 *
 * Accepts ISO and epoch milliseconds only. The bookmarklet runs in HK's
 * browser, where the page's own wording can be parsed against his real
 * timezone, so it sends something unambiguous and the server does not have to
 * guess what "Ends Thursday at 11:59pm" means from a datacenter in us-west2.
 */
export function parseCloseInput(value, { now = DateTime.now() } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, reason: 'no time given' };

  let dt = null;
  if (/^\d{13}$/.test(raw)) dt = DateTime.fromMillis(Number(raw));
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) dt = DateTime.fromISO(raw, { setZone: true });
  // Anything else is Target's own wording, straight off the page.
  else dt = parseCloseText(raw, { now });

  if (!dt?.isValid) return { ok: false, reason: `could not read "${raw}" as a time` };
  if (dt <= now) return { ok: false, reason: 'that time has already passed' };
  // A draw that supposedly runs for months is a parsing accident, not a draw.
  if (dt > now.plus({ days: 60 })) return { ok: false, reason: 'that time is more than 60 days out' };
  return { ok: true, closesAt: dt.toUTC() };
}

/** The TCIN out of any Target product URL shape. */
export function tcinFromUrl(url) {
  const m = String(url ?? '').match(/\/A-(\d{6,})/i);
  return m ? m[1] : null;
}

/**
 * The bookmarklet.
 *
 * Deliberately shows its best guess for confirmation rather than sending
 * silently. Nobody has seen the signed in markup yet, so the extractor is a
 * first attempt: a wrong time sent without a look would schedule the closing
 * reminder against a fiction, and HK would have no idea until it fired at the
 * wrong hour. It also posts back the text it matched, so the guesswork can be
 * replaced with a real selector once we have seen a few.
 */
export function bookmarkletSource(baseUrl, key) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/target/close`;
  return `(function(){
  var m = location.pathname.match(/\\/A-(\\d{6,})/i);
  if (!m) { alert('Not a Target product page.'); return; }
  var tcin = m[1];
  var near = document.body.innerText.match(
    /[^\\n]{0,60}(?:enter by|entries close|drawing closes|closes|ends)[^\\n]{0,60}/i);
  var found = near ? near[0].trim() : '';

  function send(value, isRetry) {
    fetch('${endpoint}?key=${encodeURIComponent(key)}&tcin=' + encodeURIComponent(tcin)
          + '&closes=' + encodeURIComponent(value)
          + '&raw=' + encodeURIComponent(found.slice(0, 300)))
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (t.indexOf('Saved') === 0 || isRetry) { alert(t); return; }
        var typed = prompt(
          t + '\\n\\nTarget says: ' + (found || '(nothing found on the page)')
            + '\\n\\nType the close time, e.g. 10am CT on Nov 11', found);
        if (typed) send(typed, true);
      })
      .catch(function (e) { alert('Could not reach the bot: ' + e.message); });
  }

  if (found) { send(found, false); return; }
  var typed = prompt('No close time found on this page.\\n\\n'
    + 'Type it, e.g. 10am CT on Nov 11', '');
  if (typed) send(typed, true);
})();`;
}

/** The same thing as a draggable `javascript:` URL. */
export function bookmarkletUrl(baseUrl, key) {
  const src = bookmarkletSource(baseUrl, key).replace(/\n\s*/g, ' ');
  return `javascript:${encodeURIComponent(src)}`;
}
