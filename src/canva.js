import { createHash, randomBytes } from 'node:crypto';
import { getSecret, setSecret, deleteSecret } from './db.js';

const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';

export const SCOPES = [
  'design:content:read',
  'design:content:write',
  'design:meta:read',
  'asset:read',
  'asset:write',
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
  'profile:read',
].join(' ');

const REFRESH_KEY = 'canva_refresh_token';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const newVerifier = () => b64url(randomBytes(64)).slice(0, 96);
export const challengeFor = (verifier) => b64url(createHash('sha256').update(verifier).digest());

export function authorizeUrl({ clientId, verifier, state, redirectUri }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
    state,
  });
  if (redirectUri) q.set('redirect_uri', redirectUri);
  return `${AUTHORIZE_URL}?${q}`;
}

function basicAuth() {
  const id = process.env.CANVA_CLIENT_ID;
  const secret = process.env.CANVA_CLIENT_SECRET;
  if (!id || !secret) throw new Error('CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth() },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Canva token request failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Finish the authorisation flow and store the refresh token.
 *
 * Canva refresh tokens are single use: every refresh returns a new one and
 * invalidates the old. Losing one means redoing the browser approval by hand,
 * so it is written to the database before anything else happens with it.
 */
export async function exchangeCode({ code, verifier, redirectUri }) {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
  await setSecret(REFRESH_KEY, tokens.refresh_token);
  cache = { accessToken: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 14400) * 1000 };
  return tokens;
}

let cache = { accessToken: null, expiresAt: 0 };
let inFlight = null;

/**
 * An access token, refreshing when needed.
 *
 * Access tokens last about four hours. Refreshes are serialised through a
 * single promise because two concurrent refreshes would each consume the
 * single use token and one would lose, breaking the integration until someone
 * reauthorised by hand.
 */
export async function accessToken({ skew = 60_000 } = {}) {
  if (cache.accessToken && Date.now() < cache.expiresAt - skew) return cache.accessToken;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const stored = await getSecret(REFRESH_KEY);
    if (!stored) throw new Error('Canva is not connected yet. Visit the connect URL printed at startup.');

    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: stored });
    if (!tokens.refresh_token) throw new Error('Canva returned no new refresh token');

    await setSecret(REFRESH_KEY, tokens.refresh_token);
    cache = { accessToken: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 14400) * 1000 };
    return cache.accessToken;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

export async function isConnected() {
  return Boolean(await getSecret(REFRESH_KEY));
}

export async function disconnect() {
  cache = { accessToken: null, expiresAt: 0 };
  await deleteSecret(REFRESH_KEY);
}

export const pendingKey = (state) => `canva_pending_${state}`;
export const savePending = (state, verifier) => setSecret(pendingKey(state), verifier);
export const takePending = async (state) => {
  const v = await getSecret(pendingKey(state));
  if (v) await deleteSecret(pendingKey(state));
  return v;
};
