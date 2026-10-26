import { createServer } from 'node:http';
import { getImage } from './db.js';

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
