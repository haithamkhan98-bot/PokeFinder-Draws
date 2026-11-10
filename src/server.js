import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getImage } from './db.js';
import { authorizeUrl, exchangeCode, savePending, takePending, isConnected } from './canva.js';
import { setTargetCloseTime, getSecret, setSecret } from './db.js';
import { closeKey, parseCloseInput, bookmarkletUrl } from './target-close.js';

/**
 * A one time key guarding the Canva connect route.
 *
 * The service is on a public URL. Without a guard, a stranger could start the
 * authorisation flow, approve it with their own Canva account, and the service
 * would store their refresh token instead of HK's. The key is printed in the
 * Railway logs at startup, so only someone who can read those can begin.
 */
export const setupKey = process.env.SETUP_KEY || randomBytes(12).toString('hex');

/**
 * Where the images are reachable from outside.
 *
 * Railway injects RAILWAY_PUBLIC_DOMAIN once the service has a domain, so in
 * the normal case nothing needs configuring. PUBLIC_BASE_URL is there to
 * override it if the service ever moves behind a custom domain.
 */
export function publicBaseUrl() {
  const explicit = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  return railway ? `https://${railway}` : null;
}

export function imageUrl(id) {
  const base = publicBaseUrl();
  return base ? `${base}/images/${id}.png` : null;
}

/**
 * Lets the bookmarklet read this service's reply.
 *
 * It runs on target.com and calls here, which is cross origin. The browser
 * sends a plain GET like that regardless, so without these headers the close
 * time still saves and only the answer is withheld: the bookmarklet reports
 * "Failed to fetch" for a request that worked, which is the worst of both.
 *
 * `*` rather than target.com specifically. The route carries no cookies, so
 * there is nothing for another origin to ride on, and the key is what guards
 * it. Naming one origin would also break the moment Target serves a page from
 * a different one.
 */
const CORS = { 'access-control-allow-origin': '*' };

const ID_RE = /^\/images\/([0-9a-f]{32})\.png$/;

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/**
 * A page whose body is already HTML.
 *
 * `page` escapes its body, which is right for the Canva routes since they pass
 * plain sentences. The bookmarklet page needs a real anchor, so it needs a
 * variant that does not escape. Kept separate rather than adding a flag to
 * `page`, so that the escaping one stays the default and nothing starts
 * emitting unescaped text by forgetting an argument.
 */
/**
 * The in flight OAuth state for Reddit, kept in the secrets table the way
 * Canva's is. It only has to survive the round trip to Reddit and back, but a
 * redeploy mid flow would lose an in memory one and the redirect would look
 * forged.
 */
const redditPendingKey = (state) => `reddit_pending:${state}`;
const savePendingReddit = (state) => setSecret(redditPendingKey(state), '1');
const takePendingReddit = async (state) => {
  const found = await getSecret(redditPendingKey(state));
  if (found) await setSecret(redditPendingKey(state), '');
  return Boolean(found);
};

function pageHtml(res, status, title, bodyHtml) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`
    + `<body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">`
    + `<h1 style="font-size:1.3rem">${esc(title)}</h1>${bodyHtml}</body>`,
  );
}

function page(res, status, title, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`
    + `<body style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">`
    + `<h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(body)}</p></body>`,
  );
}

export function startServer({ port = process.env.PORT ?? 3000 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }

      const path = (req.url ?? '').split('?')[0];

      if (path === '/health' || path === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }

      if (path === '/target/bookmarklet') {
        // Guarded by the SETUP key, not the close key: this page hands out the
        // close key, so guarding it with the thing it gives away would be no
        // guard at all.
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== setupKey) {
          page(res, 403, 'Target close time',
            'Wrong or missing key. The correct URL is printed in the Railway logs at startup.');
          return;
        }
        const base = publicBaseUrl();
        if (!base) {
          page(res, 500, 'Target close time', 'No public URL for this service yet.');
          return;
        }
        const href = bookmarkletUrl(base, closeKey);
        pageHtml(res, 200, 'Target close time', [
          '<p>Drag this onto your bookmarks bar:</p>',
          `<p style="margin:1.5rem 0"><a href="${esc(href)}"`,
          ' style="display:inline-block;padding:.6rem 1rem;border:1px solid #888;',
          'border-radius:6px;text-decoration:none;font-weight:600">Target draw close</a></p>',
          '<p>Then, on a Target listing that is drawing, while signed in, click it.',
          ' It reads the close time off the page, shows you what it found, and sends it here.</p>',
          // Chrome sometimes refuses to drag a javascript: link, and silently
          // drops it rather than saying so. The textarea is the way out.
          '<p>If dragging does not work, add a bookmark by hand and paste this',
          ' as its address:</p>',
          `<textarea readonly rows="4" style="width:100%;font:12px/1.4 ui-monospace,monospace"`,
          ` onclick="this.select()">${esc(href)}</textarea>`,
          '<p style="color:#666;font-size:.9rem">If it finds nothing on the page, type the time',
          ' in yourself and it still saves. Either way it sends back the text it read, so the',
          ' guessing can be replaced with something exact once a few have come through.</p>',
        ].join(''));
        return;
      }

      if (path === '/target/close') {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== closeKey) {
          res.writeHead(403, { ...CORS, 'content-type': 'text/plain' }).end('Wrong or missing key.');
          return;
        }
        const tcin = (url.searchParams.get('tcin') ?? '').trim();
        if (!/^\d{6,}$/.test(tcin)) {
          res.writeHead(400, { ...CORS, 'content-type': 'text/plain' }).end('Need a tcin.');
          return;
        }
        const parsed = parseCloseInput(url.searchParams.get('closes'));
        if (!parsed.ok) {
          res.writeHead(400, { ...CORS, 'content-type': 'text/plain' }).end(`Not saved: ${parsed.reason}`);
          return;
        }
        await setTargetCloseTime({
          tcin,
          closesAt: parsed.closesAt.toJSDate(),
          raw: url.searchParams.get('raw') || null,
        });
        res.writeHead(200, { ...CORS, 'content-type': 'text/plain' })
          .end(`Saved. TCIN ${tcin} closes ${parsed.closesAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} ET.`);
        return;
      }

      if (path === '/reddit/connect') {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== setupKey) {
          page(res, 403, 'Reddit', 'Wrong or missing key. The correct connect URL is printed in the Railway logs at startup.');
          return;
        }
        if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
          page(res, 500, 'Reddit',
            'REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not set on this service yet.');
          return;
        }
        const reddit = await import('./reddit.js');
        const state = randomBytes(16).toString('hex');
        await savePendingReddit(state);
        res.writeHead(302, {
          location: reddit.authorizeUrl({
            state, redirectUri: `${publicBaseUrl()}/reddit/redirect`,
          }),
        }).end();
        return;
      }

      if (path === '/reddit/redirect') {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const denied = url.searchParams.get('error');

        if (denied) { page(res, 400, 'Reddit declined', `Reddit returned: ${denied}`); return; }
        if (!code || !state) { page(res, 400, 'Something is missing', 'No code or state came back from Reddit.'); return; }
        // An unknown state means this redirect did not come from a flow this
        // service started, so it is stale or forged. Either way, refuse it.
        if (!await takePendingReddit(state)) {
          page(res, 400, 'Expired or unrecognised', 'Start again from the connect URL in the Railway logs.');
          return;
        }

        try {
          const reddit = await import('./reddit.js');
          const { scopes } = await reddit.exchangeCode({
            code, redirectUri: `${publicBaseUrl()}/reddit/redirect`,
          });
          const who = await reddit.me().catch(() => null);
          const missing = reddit.SCOPES.filter((sc) => !String(scopes ?? '').includes(sc));
          page(res, 200, 'Reddit connected',
            `Connected${who?.name ? ` as u/${who.name}` : ''}. The refresh token is stored.`
            + (missing.length
              ? ` WARNING: these scopes were not granted: ${missing.join(', ')}.`
                + ' Without modposts the bot cannot approve its own posts, so AutoModerator removals will stick.'
              : ' All scopes granted, including modposts for instant self approval.')
            + ' You can close this tab.');
        } catch (err) {
          console.error('reddit token exchange failed:', err.message);
          page(res, 500, 'Could not finish', err.message);
        }
        return;
      }

      if (path === '/reddit/status') {
        const reddit = await import('./reddit.js');
        const connected = await reddit.isConnected().catch(() => false);
        if (!connected) { page(res, 200, 'Reddit', 'Not connected.'); return; }
        const who = await reddit.me().catch((e) => ({ error: e.message }));
        page(res, 200, 'Reddit', who?.name ? `Connected as u/${who.name}.` : `Connected, but: ${who?.error}`);
        return;
      }

      if (path === '/canva/connect') {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== setupKey) {
          res.writeHead(403, { 'content-type': 'text/plain' })
            .end('Wrong or missing key. The correct connect URL is printed in the Railway logs at startup.');
          return;
        }
        const state = randomBytes(16).toString('hex');
        const verifier = (await import('./canva.js')).newVerifier();
        await savePending(state, verifier);
        const redirectUri = `${publicBaseUrl()}/oauth/redirect`;
        res.writeHead(302, {
          location: authorizeUrl({ clientId: process.env.CANVA_CLIENT_ID, verifier, state, redirectUri }),
        }).end();
        return;
      }

      if (path === '/oauth/redirect') {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const denied = url.searchParams.get('error');

        if (denied) { page(res, 400, 'Canva declined', `Canva returned: ${denied}`); return; }
        if (!code || !state) { page(res, 400, 'Something is missing', 'No code or state came back from Canva.'); return; }

        // An unknown state means this redirect did not come from a flow we
        // started, so it is either stale or forged. Either way, refuse it.
        const verifier = await takePending(state);
        if (!verifier) { page(res, 400, 'Expired or unrecognised', 'Start again from the connect URL in the Railway logs.'); return; }

        try {
          await exchangeCode({ code, verifier, redirectUri: `${publicBaseUrl()}/oauth/redirect` });
          page(res, 200, 'Canva connected', 'The refresh token is stored. You can close this tab, nothing else to do.');
        } catch (err) {
          console.error('canva token exchange failed:', err.message);
          page(res, 500, 'Could not finish', err.message);
        }
        return;
      }

      if (path === '/canva/status') {
        const connected = await isConnected().catch(() => false);
        res.writeHead(200, { 'content-type': 'text/plain' }).end(connected ? 'connected' : 'not connected');
        return;
      }

      const match = ID_RE.exec(path);
      if (!match) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }

      const row = await getImage(match[1]);
      if (!row) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }

      // The id is a content hash, so the bytes behind a URL never change and it
      // is safe to let Buffer and X cache them indefinitely.
      res.writeHead(200, {
        'content-type': row.mime,
        'content-length': row.bytes.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(row.bytes);
    } catch (err) {
      console.error('image server error:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('error');
    }
  });

  server.listen(port, () => console.log(`image server listening on port ${port}`));
  return server;
}
