/**
 * Affiliate links from HK's Google Sheet.
 *
 * The sheet is the only place a Walmart affiliate link exists. A monitor embed
 * carries one only when HK set it by hand, so without this a queue item he has
 * already generated a link for still posts as a plain PokeFinder URL and earns
 * nothing.
 *
 * Read through the tab's "publish to web" CSV rather than the Sheets API. That
 * needs no credential in Railway and no service account, at the cost of being
 * read only and lagging HK's edits by Google's cache, which is around five
 * minutes. Both are fine here: the bot never writes, and a link added minutes
 * before a drop is an edge case HK can fix by hand.
 */

/**
 * RFC 4180 enough for a Google Sheets export.
 *
 * Written out rather than pulled in as a dependency because the hard parts are
 * quoted commas and doubled quotes inside a quoted field, both of which appear
 * in product names, and both of which a naive split on comma gets wrong.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; continue; }
        quoted = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
/** SKUs are compared as digits. The sheet has them as text, numbers and with stray spaces. */
export const skuKey = (s) => String(s ?? '').replace(/[^0-9]/g, '');

/**
 * Find a column by header name, tolerating wording drift.
 *
 * Matched on a substring so "Walmart Link" and "Target Link" both answer to
 * "link", and a rename to "Affiliate Links" does not break the lookup. The
 * caller decides whether a missing column is fatal.
 */
function columnIndex(header, ...wanted) {
  for (const w of wanted) {
    const i = header.findIndex((h) => norm(h).includes(w));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * The sheet rows as a SKU to affiliate link map.
 *
 * The Set column is populated only on the first row of each block and blank
 * on the rest, so it is carried down. Getting this wrong is not hypothetical:
 * reading the Set per row is how two 30th Celebration SKUs were once reported
 * as belonging to no set at all.
 *
 * Throws when the SKU or affiliate column is missing, rather than returning an
 * empty map. An empty map is indistinguishable from "no links known" and would
 * quietly post plain URLs for every item.
 */
export function parseLinkSheet(csv) {
  const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim()));
  if (!rows.length) throw new Error('the sheet came back empty');

  const header = rows[0];
  const iSku = columnIndex(header, 'sku', 'pid');
  const iAff = columnIndex(header, 'affiliate');
  const iSet = columnIndex(header, 'set');
  const iName = columnIndex(header, 'product');
  if (iSku === -1 || iAff === -1) {
    throw new Error(
      `the sheet has no ${iSku === -1 ? 'SKU' : 'Affiliate Link'} column. `
      + `Headers seen: ${header.filter(Boolean).join(', ')}`,
    );
  }

  const bySku = new Map();
  let set = '';
  for (const row of rows.slice(1)) {
    if (iSet !== -1 && String(row[iSet] ?? '').trim()) set = row[iSet].trim();
    const sku = skuKey(row[iSku]);
    if (!sku) continue;
    const affiliate = String(row[iAff] ?? '').trim();
    bySku.set(sku, {
      sku,
      set,
      product: iName === -1 ? '' : String(row[iName] ?? '').trim(),
      // An empty cell and a placeholder both mean "no link yet". Treating the
      // placeholder as a link would post "[AFFILIATE LINK NEEDED]" as a URL.
      affiliate: /^\[.*\]$/.test(affiliate) || !/^https?:\/\//i.test(affiliate) ? null : affiliate,
    });
  }
  return bySku;
}

let cache = { at: 0, map: null, url: null };

/** Drop the cached sheet, so the next load refetches. For tests and for !sheetrefresh. */
export const forgetSheet = () => { cache = { at: 0, map: null, url: null }; };

/**
 * The SKU to link map, cached in process.
 *
 * Cached for five minutes because a queue run looks up ten items and Google
 * caches the published CSV on about that cycle anyway, so refetching per item
 * would be ten requests for one answer.
 *
 * On a failed fetch the previous map is served if there is one. A queue drop
 * with slightly stale links beats a queue drop with none.
 */
export async function loadAffiliateLinks({
  url = process.env.WALMART_SHEET_CSV,
  ttlMs = 5 * 60_000,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!url) return null;
  if (cache.map && cache.url === url && now() - cache.at < ttlMs) return cache.map;

  try {
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // A published sheet that has been unpublished answers with an HTML error
    // page and HTTP 200, which would otherwise parse as one nonsense row.
    if (/^\s*</.test(text)) throw new Error('got HTML rather than CSV, so the sheet may have been unpublished');
    const map = parseLinkSheet(text);
    cache = { at: now(), map, url };
    return map;
  } catch (err) {
    if (cache.map && cache.url === url) {
      console.error(`sheet refresh failed, using the copy from ${new Date(cache.at).toISOString()}: ${err.message}`);
      return cache.map;
    }
    throw new Error(`could not read the affiliate sheet: ${err.message}`);
  }
}

/** What the alert channel says about a load. */
export function summariseSheet(map) {
  if (!map) return 'no sheet configured, so every item uses its plain link';
  const withLink = [...map.values()].filter((r) => r.affiliate).length;
  return `sheet: ${map.size} SKUs, ${withLink} with affiliate links`;
}

/** The SKUs with no affiliate link, in sheet order. */
export function missingLinks(map) {
  return map ? [...map.values()].filter((r) => !r.affiliate) : [];
}

/**
 * The alert naming every SKU that still needs an affiliate link.
 *
 * Grouped by set, because that is how the sheet is laid out and how HK works
 * through it. A flat list of 11 SKUs means hunting for each row.
 *
 * Returns null when nothing is missing, so the caller sends nothing rather
 * than an all clear nobody asked for.
 */
export function missingLinksAlert(map, { mention = null } = {}) {
  const missing = missingLinks(map);
  if (!missing.length) return null;

  const bySet = new Map();
  for (const r of missing) {
    const key = r.set || 'No set';
    if (!bySet.has(key)) bySet.set(key, []);
    bySet.get(key).push(r);
  }

  const blocks = [...bySet].map(([set, rows]) => `**${set}**\n`
    + rows.map((r) => `${r.product || '(no product name)'} ${r.sku}`).join('\n'));

  return `${mention ? `${mention} ` : ''}**${missing.length} Walmart SKU${missing.length === 1 ? '' : 's'} `
    + `still need${missing.length === 1 ? 's' : ''} an affiliate link.** `
    + 'Until they have one they post as plain PokeFinder links and earn nothing.\n\n'
    + `${blocks.join('\n\n')}`;
}

/**
 * A stable fingerprint of the missing set, so the same list is not re-sent.
 *
 * Railway rolls containers over on every deploy, and several deploys can land
 * within a minute. Alerting on each boot would be three pings saying the same
 * thing. This changes only when the actual set of SKUs without links changes,
 * which is the moment worth hearing about.
 */
export function missingFingerprint(map) {
  return missingLinks(map).map((r) => r.sku).sort().join(',');
}
