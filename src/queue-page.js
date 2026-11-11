/**
 * The live Walmart collectibles queue page.
 *
 * Used inverted, which is the opposite of the obvious reading. An item shown
 * on this page is in the queue that is running NOW, so a monitor ping for it
 * is the item LEAVING rather than joining. The upcoming drop's items are
 * loaded behind the page and do not appear on it: of four items in a real
 * upcoming drop, none were on the page, while two of eleven stale pings were.
 *
 * So the page cannot tell you what is coming. It can positively convict some
 * of what is not.
 */
export const QUEUE_PAGE = 'https://www.walmart.com/shop/collectibles/queue';

/** Walmart item ids in a product URL: /ip/<slug>/<id> or /ip/<id>. */
const ITEM_URL = /\/ip\/(?:[^/\s"']*\/)?(\d{6,})/g;

/**
 * Item ids currently on the queue page.
 *
 * Scraped from product links rather than from any JSON blob, because the link
 * shape has been stable for years while Walmart's embedded state has not.
 *
 * Returns null rather than an empty set when the page cannot be read. An empty
 * set means "nothing is queued", which would convict nothing; null means "no
 * signal", and the caller must not treat the two the same.
 */
export async function queuePageIds({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetchImpl(QUEUE_PAGE, {
      signal: control.signal,
      headers: {
        // An honest agent. Walmart serves the page to it; pretending to be a
        // browser would be both a lie and more likely to be blocked.
        'user-agent': 'PokeFinderBot/1.0 (+https://pokefinder.io)',
        accept: 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // A bot wall returns 200 with a challenge page, which would otherwise
    // parse as a queue with nothing in it.
    if (/captcha|robot or human|blocked/i.test(html.slice(0, 4000))) return null;

    const ids = new Set();
    for (const m of html.matchAll(ITEM_URL)) ids.add(m[1]);
    return ids.size ? ids : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Split items into arrival clusters.
 *
 * The real drop arrives as one burst and the clear-out pings follow a minute
 * or two later: four items at 17:46:58, eleven more from 17:48:20. The queue
 * batcher's five minute quiet period swallows both into one run, and the
 * arrival times were being thrown away.
 *
 * Gap based rather than a fixed window from the first item, so a drop that
 * trickles in over several minutes stays one cluster as long as nothing
 * pauses longer than the gap.
 */
export function clusterByArrival(items, { gapMs = 45_000 } = {}) {
  const withTime = items.filter((i) => Number.isFinite(i.seenAt));
  // No timestamps means no signal: one cluster, so nothing is convicted by
  // position alone.
  if (withTime.length !== items.length) return [items.map((i) => ({ ...i, cluster: 0 }))];

  const sorted = [...items].sort((a, b) => a.seenAt - b.seenAt);
  const clusters = [];
  let current = [];
  let previous = null;
  for (const item of sorted) {
    if (previous !== null && item.seenAt - previous > gapMs) {
      clusters.push(current);
      current = [];
    }
    current.push({ ...item, cluster: clusters.length });
    previous = item.seenAt;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

/**
 * Decide which items are really in the drop.
 *
 * An item in the first cluster is always kept, even when it was queued
 * recently: Walmart does re-queue products, and that item arrived with the
 * real drop. Later clusters are dropped only on evidence, so a late arrival
 * nobody can convict is kept and flagged rather than guessed away.
 */
export function selectDropItems(items, { previousPids = new Map(), livePageIds = null, gapMs } = {}) {
  const clusters = clusterByArrival(items, gapMs ? { gapMs } : undefined);
  const decided = [];

  for (const cluster of clusters) {
    for (const item of cluster) {
      const pid = String(item.pid);
      const seenBefore = previousPids.get(pid) ?? null;
      const onPage = livePageIds ? livePageIds.has(pid) : null;
      const evidence = [
        seenBefore && `in the ${seenBefore} queue`,
        onPage && 'on the live queue page now',
      ].filter(Boolean);

      const keep = item.cluster === 0 || evidence.length === 0;
      decided.push({
        ...item, seenBefore, onPage, evidence, keep,
        why: item.cluster === 0
          ? 'first arrival burst'
          : evidence.length
            ? `later burst, ${evidence.join(' and ')}`
            : 'later burst, but nothing against it',
      });
    }
  }

  return {
    clusters: clusters.length,
    kept: decided.filter((d) => d.keep),
    dropped: decided.filter((d) => !d.keep),
    all: decided,
  };
}

/** The per item evidence, for the alert. */
export function explainSelection(result) {
  return result.all
    .map((d) => `  ${d.keep ? 'KEEP' : 'DROP'} c${d.cluster} ${d.productName ?? d.rawTitle} (${d.pid}) ${d.why}`)
    .join('\n');
}
