/**
 * Reads of Target product listings.
 *
 * The raffle automation needs to know whether a listing is still drawing
 * gated, so a reminder can drop items Target pulled mid window. Target serves
 * that as a boolean in the page's embedded JSON.
 *
 * Whether Target serves that page to this service at all is the open question.
 * It blocks plenty of automated reads, and Railway is a datacenter address,
 * which it treats more harshly than a home browser. So `probeListing` exists
 * to answer that with evidence before anything is built on top of it.
 *
 * We identify ourselves honestly in the User-Agent rather than impersonating a
 * browser. If Target would rather not serve us, that is its answer and the
 * removal detection has to work some other way.
 */

export const TARGET_UA = 'PokeFinderBot/1.0 (+https://pokefinder.io)';

/** HK's normalised form. Target's own URLs use `/p/<slug>/-/A-<tcin>`. */
export function targetUrl(tcin) {
  return `https://www.target.com/p/PokeFinder/A-${String(tcin ?? '').trim()}`;
}

/**
 * The drawing gate flag, or null when the page does not carry it.
 *
 * Matched against the raw page rather than walked down a path, because the
 * flag sits behind array indices (`queries.4`, `data_source_modules.1`) that
 * shift the moment Target reorders anything.
 */
export function readQueueGated(html) {
  const m = String(html ?? '').match(/"queue_gated"\s*:\s*(true|false)/i);
  return m ? m[1].toLowerCase() === 'true' : null;
}

/**
 * Any timestamp on the page that falls near today, in either format Target
 * might use.
 *
 * The raffle posts want the draw's close time, and so far it has only been
 * seen while signed in. Before accepting that, this looks for it properly: an
 * earlier search only matched ISO strings, so a window stored as epoch
 * milliseconds would have gone unnoticed.
 *
 * Content expiry dates litter these pages, all of them years out, so anything
 * beyond the window is noise and dropped. Each hit carries the 60 characters
 * in front of it, which is normally enough to name the field it belongs to.
 */
export function nearTermTimes(html, { now = Date.now(), days = 60 } = {}) {
  const h = String(html ?? '');
  const lo = now - 2 * 86_400_000;
  const hi = now + days * 86_400_000;
  const hits = [];

  for (const m of h.matchAll(/.{0,60}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"\s]{0,10})/g)) {
    const t = Date.parse(m[1]);
    if (t >= lo && t <= hi) hits.push({ value: m[1], context: m[0].replace(/\s+/g, ' ').trim() });
  }
  // Epoch milliseconds: 13 digits, not preceded by another digit.
  for (const m of h.matchAll(/.{0,60}?(?<![\d.])(1[6-9]\d{11})(?![\d.])/g)) {
    const t = Number(m[1]);
    if (t >= lo && t <= hi) {
      hits.push({ value: `${m[1]} (${new Date(t).toISOString()})`, context: m[0].replace(/\s+/g, ' ').trim() });
    }
  }

  const seen = new Set();
  return hits.filter((x) => !seen.has(x.value) && seen.add(x.value)).slice(0, 12);
}

const WALL = [
  /press\s*&(amp;)?\s*hold/i, /px-captcha/i, /perimeterx/i, /_px\w*Captcha/i,
  /access\s+denied/i, /unusual\s+traffic/i, /are\s+you\s+a\s+human/i,
  /bot\s*detection/i, /request\s+blocked/i,
];

/** True when the body looks like a block page rather than a product page. */
export function looksWalled(html) {
  const h = String(html ?? '');
  return WALL.some((re) => re.test(h));
}

/**
 * Fetch one listing and report what came back.
 *
 * Never throws: a probe that explodes tells us nothing, and the failure mode
 * is exactly what we are trying to measure.
 */
export async function probeListing(tcin, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const url = targetUrl(tcin);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': TARGET_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    return {
      tcin: String(tcin), url, ok: res.ok, status: res.status,
      ms: Date.now() - started, bytes: html.length, finalUrl: res.url ?? url,
      hasNextData: html.includes('__NEXT_DATA__'),
      queueGated: readQueueGated(html),
      walled: looksWalled(html),
      times: nearTermTimes(html),
      error: null,
    };
  } catch (err) {
    return {
      tcin: String(tcin), url, ok: false, status: null,
      ms: Date.now() - started, bytes: 0, finalUrl: url,
      hasNextData: false, queueGated: null, walled: false, times: [],
      error: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The probe result as a block for the alert channel. */
export function formatProbe(r) {
  const verdict = r.error ? `FAILED: ${r.error}`
    : r.walled ? 'BLOCKED: this is a bot wall, not a product page'
    : !r.ok ? `REFUSED: HTTP ${r.status}`
    : r.queueGated === null ? 'SERVED, but no queue_gated flag on the page'
    : `SERVED, queue_gated = ${r.queueGated}`;
  return [
    `tcin        ${r.tcin}`,
    `url         ${r.url}`,
    `status      ${r.status ?? 'none'}${r.ok ? ' ok' : ''}`,
    `took        ${r.ms}ms`,
    `bytes       ${r.bytes.toLocaleString('en-US')}`,
    `__NEXT_DATA__  ${r.hasNextData ? 'present' : 'absent'}`,
    `queue_gated ${r.queueGated === null ? 'not found' : r.queueGated}`,
    `bot wall    ${r.walled ? 'yes' : 'no'}`,
    `near dates  ${r.times?.length ? '' : 'none'}`,
    ...(r.times ?? []).map((t) => `   ${t.value}\n     ...${t.context}`),
    '',
    verdict,
  ].join('\n');
}
