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
  else dt = DateTime.fromISO(raw, { setZone: true });

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
  var text = document.body.innerText;
  var hit = null;
  var near = text.match(/[^\\n]{0,80}(ends|closes|enter by|entries close|drawing closes)[^\\n]{0,80}/i);
  if (near) {
    var d = new Date(near[0].replace(/^[^]*?(?:ends|closes|enter by|entries close|drawing closes)\\s*:?\\s*/i, ''));
    if (!isNaN(d)) hit = d;
  }
  var guess = hit ? hit.toISOString() : '';
  var answer = prompt(
    'Close time for TCIN ' + tcin + '\\n\\n' +
    (near ? 'Found on the page:\\n' + near[0].trim() + '\\n\\n' : 'Nothing found on the page.\\n\\n') +
    'Send this time (edit if wrong):',
    guess || ''
  );
  if (!answer) return;
  var u = '${endpoint}?key=${encodeURIComponent(key)}&tcin=' + encodeURIComponent(tcin)
        + '&closes=' + encodeURIComponent(answer)
        + '&raw=' + encodeURIComponent(near ? near[0].trim().slice(0, 300) : '');
  fetch(u).then(function(r){ return r.text(); }).then(function(t){ alert(t); })
          .catch(function(e){ alert('Could not reach the bot: ' + e.message); });
})();`;
}

/** The same thing as a draggable `javascript:` URL. */
export function bookmarkletUrl(baseUrl, key) {
  const src = bookmarkletSource(baseUrl, key).replace(/\n\s*/g, ' ');
  return `javascript:${encodeURIComponent(src)}`;
}
