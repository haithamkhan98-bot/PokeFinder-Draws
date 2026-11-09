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
      error: null,
    };
  } catch (err) {
    return {
      tcin: String(tcin), url, ok: false, status: null,
      ms: Date.now() - started, bytes: 0, finalUrl: url,
      hasNextData: false, queueGated: null, walled: false,
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
    '',
    verdict,
  ].join('\n');
}
