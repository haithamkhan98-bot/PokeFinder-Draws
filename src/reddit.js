import { getSecret, setSecret } from './db.js';
import { toRichtext } from './reddit-richtext.js';

/**
 * Reddit's API.
 *
 * Reddit requires a descriptive User-Agent and throttles or blocks generic
 * ones outright, so this is not optional furniture.
 */
export const UA = process.env.REDDIT_USER_AGENT
  || 'web:io.pokefinder.draws:1.0 (by /u/TCGDropsDeals)';

const AUTH_HOST = 'https://www.reddit.com';
const API_HOST = 'https://oauth.reddit.com';
const TOKEN_KEY = 'reddit_refresh_token';

/**
 * The scopes the bot needs, and why each one.
 *
 * `modposts` is the load bearing one: HK's own posts to his own subs are
 * removed instantly by AutoModerator, and approving straight after submitting
 * is what keeps them up. Without it the posts go out and vanish.
 */
export const SCOPES = ['identity', 'submit', 'read', 'modposts', 'flair'];

const basic = () => Buffer
  .from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`)
  .toString('base64');

export function authorizeUrl({ state, redirectUri }) {
  const q = new URLSearchParams({
    client_id: process.env.REDDIT_CLIENT_ID ?? '',
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    // Without `permanent` Reddit issues a one hour token and no refresh token,
    // so the bot would stop posting an hour after setup.
    duration: 'permanent',
    scope: SCOPES.join(' '),
  });
  return `${AUTH_HOST}/api/v1/authorize?${q}`;
}

async function tokenRequest(body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${AUTH_HOST}/api/v1/access_token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic()}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`reddit token ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`reddit token error: ${json.error}`);
  return json;
}

/** One time, from the OAuth redirect. Stores the refresh token in Postgres. */
export async function exchangeCode({ code, redirectUri, fetchImpl = fetch }) {
  const json = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
  }, { fetchImpl });
  if (!json.refresh_token) {
    throw new Error('Reddit returned no refresh token. The app must be a "web app" and the request must ask for permanent duration.');
  }
  await setSecret(TOKEN_KEY, json.refresh_token);
  return { scopes: json.scope };
}

export const isConnected = async () => Boolean(await getSecret(TOKEN_KEY).catch(() => null));

let cached = { token: null, until: 0 };

/**
 * A bearer token, refreshed when it is close to expiring.
 *
 * Refreshed sixty seconds early rather than on expiry: a token that dies
 * between the submit and the approve would leave a post up and unapproved,
 * which is the one state this whole path exists to avoid.
 */
export async function accessToken({ fetchImpl = fetch, now = Date.now } = {}) {
  if (cached.token && now() < cached.until) return cached.token;
  const refresh = await getSecret(TOKEN_KEY);
  if (!refresh) throw new Error('Reddit is not connected. Open /reddit/connect with the setup key.');
  const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, { fetchImpl });
  cached = {
    token: json.access_token,
    until: now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

/** Drop the cached token, so the next call refreshes. For tests and for 401s. */
export const forgetToken = () => { cached = { token: null, until: 0 }; };

async function api(path, { method = 'GET', form = null, fetchImpl = fetch } = {}) {
  const token = await accessToken({ fetchImpl });
  const res = await fetchImpl(`${API_HOST}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': UA,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams({ ...form, api_type: 'json' }).toString() } : {}),
  });
  const text = await res.text();
  if (res.status === 401) {
    forgetToken();
    throw new Error('reddit 401: the token was rejected, so it has been dropped and will refresh next call');
  }
  if (!res.ok) throw new Error(`reddit ${path} ${res.status}: ${text.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`reddit ${path} returned non JSON: ${text.slice(0, 200)}`); }

  // Reddit answers a rejected submit with HTTP 200 and an errors array, so a
  // status check alone would report a failed post as a success.
  const errors = json?.json?.errors;
  if (Array.isArray(errors) && errors.length) {
    throw new Error(`reddit ${path} refused: ${errors.map((e) => e.join(': ')).join('; ')}`);
  }
  return json;
}

/**
 * Put an image into Reddit's own media store and return its asset id.
 *
 * Reddit will not render an image hosted anywhere else inside a post, so the
 * grid has to be uploaded even though it already has a public URL on the
 * Railway image host. The upload is a two step: ask Reddit for a presigned S3
 * target, then PUT the bytes there.
 */
export async function uploadImage(imageUrl, { fetchImpl = fetch } = {}) {
  const got = await fetchImpl(imageUrl);
  if (!got.ok) throw new Error(`could not fetch the grid image: ${got.status}`);
  const bytes = Buffer.from(await got.arrayBuffer());
  const mimetype = got.headers.get('content-type') || 'image/png';
  const filepath = `grid.${mimetype.includes('jpeg') ? 'jpg' : 'png'}`;

  const lease = await api('/api/media/asset.json', {
    method: 'POST', form: { filepath, mimetype }, fetchImpl,
  });
  const args = lease?.args;
  const assetId = lease?.asset?.asset_id;
  if (!args?.action || !assetId) throw new Error('Reddit gave no upload target for the image');

  const form = new FormData();
  for (const { name, value } of args.fields ?? []) form.append(name, value);
  form.append('file', new Blob([bytes], { type: mimetype }), filepath);

  const action = args.action.startsWith('//') ? `https:${args.action}` : args.action;
  const put = await fetchImpl(action, { method: 'POST', body: form });
  if (!put.ok) throw new Error(`image upload to Reddit failed: ${put.status}`);
  return assetId;
}

/**
 * Submit one post, as richtext so it can carry the image and the links.
 *
 * `sendreplies` is left on: these posts exist to be engaged with, and the
 * replies are where HK answers questions about a drop.
 */
export async function submit({ sub, title, markdown, imageAssetId = null, fetchImpl = fetch }) {
  const richtext = toRichtext(markdown, { imageAssetId });
  const json = await api('/api/submit', {
    method: 'POST',
    fetchImpl,
    form: {
      sr: sub,
      kind: 'self',
      title,
      richtext_json: JSON.stringify(richtext),
      sendreplies: 'true',
      // Reddit rejects a resubmit of the same title to the same sub within a
      // window unless this is set, and a reminder post legitimately repeats a
      // title the announcement used.
      resubmit: 'true',
    },
  });
  const data = json?.json?.data;
  if (!data?.name) throw new Error('Reddit accepted the post but returned no id');
  return { fullname: data.name, url: data.url, id: data.id };
}

/**
 * Approve a post, immediately after submitting it.
 *
 * This is the point of the modposts scope. HK's posts to his own subs are
 * removed by AutoModerator on submit; approving at once means they stay up and
 * get engagement, where approving later means they were invisible meanwhile.
 */
export async function approve(fullname, { fetchImpl = fetch } = {}) {
  await api('/api/approve', { method: 'POST', form: { id: fullname }, fetchImpl });
}

/**
 * Crosspost an existing post into another sub.
 *
 * Deliberately a separate call with no automatic caller. Crossposting into
 * subs HK does not moderate is the path that risks a domain ban on the
 * affiliate links, which would break them in his own subs too, so it happens
 * when he asks for it by name and not as part of a run.
 */
export async function crosspost({ sub, title, fullname, fetchImpl = fetch }) {
  const json = await api('/api/submit', {
    method: 'POST',
    fetchImpl,
    form: {
      sr: sub, kind: 'crosspost', title,
      crosspost_fullname: fullname, sendreplies: 'true', resubmit: 'true',
    },
  });
  const data = json?.json?.data;
  if (!data?.name) throw new Error('Reddit accepted the crosspost but returned no id');
  return { fullname: data.name, url: data.url };
}

/** Who the stored token belongs to, for the status page. */
export async function me({ fetchImpl = fetch } = {}) {
  const json = await api('/api/v1/me', { fetchImpl });
  return { name: json?.name, id: json?.id };
}
