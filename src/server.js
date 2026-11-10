import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getImage } from './db.js';
import { authorizeUrl, exchangeCode, savePending, takePending, isConnected } from './canva.js';
import { setTargetCloseTime } from './db.js';
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

const ID_RE = /^\/images\/([0-9a-f]{32})\.png$/;

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

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
            '<p>Wrong or missing key. The correct URL is printed in the Railway logs at startup.</p>');
          return;
        }
        const base = publicBaseUrl();
        if (!base) {
          page(res, 500, 'Target close time', '<p>No public URL for this service yet.</p>');
          return;
        }
        page(res, 200, 'Target close time', [
          '<p>Drag this to your bookmarks bar:</p>',
          `<p><a href="${esc(bookmarkletUrl(base, closeKey))}">Target draw close</a></p>`,
          '<p>Then, on a Target listing that is drawing, while signed in, click it.',
          ' It reads the close time off the page, shows you what it found, and sends it here.</p>',
          '<p>If it finds nothing, paste the time in yourself and it will still be saved.',
          ' Either way it posts back what it saw, so the guessing can be replaced',
          ' with something exact once a few have come through.</p>',
        ].join(''));
        return;
      }

      if (path === '/target/close') {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== closeKey) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('Wrong or missing key.');
          return;
        }
        const tcin = (url.searchParams.get('tcin') ?? '').trim();
        if (!/^\d{6,}$/.test(tcin)) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end('Need a tcin.');
          return;
        }
        const parsed = parseCloseInput(url.searchParams.get('closes'));
        if (!parsed.ok) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end(`Not saved: ${parsed.reason}`);
          return;
        }
        await setTargetCloseTime({
          tcin,
          closesAt: parsed.closesAt.toJSDate(),
          raw: url.searchParams.get('raw') || null,
        });
        res.writeHead(200, { 'content-type': 'text/plain' })
          .end(`Saved. TCIN ${tcin} closes ${parsed.closesAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} ET.`);
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
