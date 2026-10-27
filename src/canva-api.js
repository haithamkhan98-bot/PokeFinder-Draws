import { accessToken } from './canva.js';

const API = 'https://api.canva.com/rest/v1';

/**
 * One call against the Canva Connect API.
 *
 * Canva answers a stale or revoked token with 401. That is worth one retry
 * with a forced refresh, because the usual cause is the access token expiring
 * mid run rather than the integration actually being broken.
 */
async function canvaFetch(path, { method = 'GET', body, headers = {}, raw = false, retried = false } = {}) {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(raw ? {} : body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried) {
    return canvaFetch(path, { method, body, headers, raw, retried: true });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Canva ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Wait for one of Canva's asynchronous jobs.
 *
 * Uploads, autofills and exports are all queued work. The first response only
 * says the job was accepted, so every one of them has to be polled before its
 * result exists.
 */
async function pollJob(path, { timeoutMs = 120_000, intervalMs = 1500, key } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await canvaFetch(path);
    const job = res.job ?? res;
    if (job.status === 'success') return job;
    if (job.status === 'failed') {
      throw new Error(`Canva ${key ?? path} job failed: ${job.error?.code ?? '?'} ${job.error?.message ?? ''}`);
    }
    if (Date.now() > deadline) throw new Error(`Canva ${key ?? path} job did not finish within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Put an image into the Canva account's asset library and return its id.
 *
 * Autofill takes asset ids, not URLs, so every product photo has to go through
 * here first. The name is capped at 50 characters before encoding because
 * Canva rejects anything longer.
 */
export async function uploadAsset(buffer, name) {
  const safe = (name || 'draw product').replace(/\s+/g, ' ').trim().slice(0, 50) || 'draw product';
  const created = await canvaFetch('/asset-uploads', {
    method: 'POST',
    raw: true,
    body: buffer,
    headers: {
      'content-type': 'application/octet-stream',
      'asset-upload-metadata': JSON.stringify({ name_base64: Buffer.from(safe, 'utf8').toString('base64') }),
    },
  });
  const job = await pollJob(`/asset-uploads/${created.job.id}`, { key: 'asset upload' });
  return job.asset.id;
}

/** Fill a copy of one of the draw templates and return the new design. */
export async function autofillFromDesign({ designId, title, data }) {
  const created = await canvaFetch('/autofills', {
    method: 'POST',
    body: { type: 'create_from_design', design_id: designId, title, data },
  });
  const job = await pollJob(`/autofills/${created.job.id}`, { key: 'autofill' });
  return job.result.design;
}

/** Render a design to PNG and return the (short lived) download URLs. */
export async function exportDesign(designId, { type = 'png' } = {}) {
  const created = await canvaFetch('/exports', {
    method: 'POST',
    body: { design_id: designId, format: { type } },
  });
  const job = await pollJob(`/exports/${created.job.id}`, { key: 'export', timeoutMs: 180_000 });
  return job.urls ?? job.result?.urls ?? [];
}

/**
 * Fetch an export straight into memory.
 *
 * Canva's export links are presigned and expire within hours, sometimes sooner
 * when the render came from cache. Buffer fetches an image when a post SENDS,
 * which can be days later, so the bytes have to be copied somewhere permanent
 * immediately. Nothing downstream ever sees a canva.com URL.
 */
export async function downloadExport(url, { timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`downloading the Canva export failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
