const ENDPOINT = 'https://api.buffer.com';

export const CHANNELS = {
  pokemonfindr: process.env.BUFFER_CHANNEL_POKEMONFINDR || '687e611496f2ca7f1ce11edb',
  collectfinder: process.env.BUFFER_CHANNEL_COLLECTFINDER || '6949f9f1457dae6a34a4c74f',
};

// Draw posts go to the two X accounts only. The Facebook page is deliberately
// left out: it carries the SKU list runs, not the draws.
export const DRAW_CHANNELS = [CHANNELS.pokemonfindr, CHANNELS.collectfinder];

const token = () => {
  const t = process.env.BUFFER_TOKEN;
  if (!t) throw new Error('BUFFER_TOKEN is not set, so no posts can be created');
  return t;
};

async function graphql(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Buffer returned ${res.status}: ${text.slice(0, 400)}`);

  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Buffer returned unreadable JSON: ${text.slice(0, 200)}`); }
  if (body.errors?.length) throw new Error(`Buffer rejected the request: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

/**
 * Build the createPost mutation.
 *
 * Values are passed inline rather than as GraphQL variables because the name of
 * the input type is not published, and getting it wrong fails the whole call.
 * Every string goes through JSON.stringify, so quotes, newlines and emoji in
 * the post text cannot break out of the literal. Enums are written bare, as
 * GraphQL requires.
 */
function createPostMutation({ channelId, text, dueAt, saveToDraft, publishNow, imageUrl, altText }) {
  const fields = [
    `channelId: ${JSON.stringify(channelId)}`,
    `text: ${JSON.stringify(text)}`,
    'schedulingType: automatic',
  ];

  if (publishNow) {
    // Publishing requires BOTH of these. mode alone leaves it a draft.
    fields.push('mode: shareNow', 'saveToDraft: false');
  } else if (dueAt) {
    fields.push('mode: customScheduled', `dueAt: ${JSON.stringify(dueAt)}`);
    if (saveToDraft) fields.push('saveToDraft: true');
  } else {
    fields.push('mode: addToQueue');
    if (saveToDraft) fields.push('saveToDraft: true');
  }

  if (imageUrl) {
    const meta = altText ? `, metadata: { altText: ${JSON.stringify(altText)} }` : '';
    fields.push(`assets: [{ image: { url: ${JSON.stringify(imageUrl)}${meta} } }]`);
  }

  return `mutation {
    createPost(input: { ${fields.join(', ')} }) {
      ... on PostActionSuccess { post { id status dueAt } }
      ... on MutationError { message }
    }
  }`;
}

/**
 * Create one post and return its Buffer id.
 *
 * A MutationError comes back as a successful HTTP response with a message in
 * the payload, so it has to be checked for explicitly or a failed post looks
 * like a created one.
 */
export async function createPost(opts) {
  const data = await graphql(createPostMutation(opts));
  const result = data?.createPost;
  if (!result) throw new Error('Buffer returned no result for createPost');
  if (result.message) throw new Error(`Buffer rejected the post: ${result.message}`);
  if (!result.post?.id) throw new Error('Buffer created the post but returned no id');
  return result.post;
}

/**
 * Create one post on each draw channel.
 *
 * Failures are collected rather than thrown. One channel refusing a post must
 * not lose the other five posts that already went up, and the run summary needs
 * to say exactly which ones are missing.
 */
export async function createOnDrawChannels(opts, channels = DRAW_CHANNELS) {
  const results = [];
  for (const channelId of channels) {
    try {
      const post = await createPost({ ...opts, channelId });
      results.push({ channelId, ok: true, postId: post.id, status: post.status });
    } catch (err) {
      results.push({ channelId, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Edit an existing post.
 *
 * Buffer documents the mutation as `editPost` taking an `EditPostInput`, but
 * does not publish that input's field names. The id key is therefore tried
 * both ways: `id` first, since the sibling deletePost is described as deleting
 * "by id", then `postId`, which is what Buffer's own MCP tool calls it. A
 * wrong field name comes back as a GraphQL validation error, so this costs one
 * failed request the first time and nothing after that.
 */
let idKey = null;

export async function editPost({ postId, text, imageUrl, altText }) {
  const attempt = async (key) => {
    const fields = [`${key}: ${JSON.stringify(postId)}`, `text: ${JSON.stringify(text)}`];
    if (imageUrl) {
      const meta = altText ? `, metadata: { altText: ${JSON.stringify(altText)} }` : '';
      fields.push(`assets: [{ image: { url: ${JSON.stringify(imageUrl)}${meta} } }]`);
    }
    const data = await graphql(`mutation {
      editPost(input: { ${fields.join(', ')} }) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on MutationError { message }
      }
    }`);
    const result = data?.editPost;
    if (!result) throw new Error('Buffer returned no result for editPost');
    if (result.message) throw new Error(`Buffer rejected the edit: ${result.message}`);
    if (!result.post?.id) throw new Error('Buffer edited the post but returned no id');
    return result.post;
  };

  if (idKey) return attempt(idKey);

  try {
    const post = await attempt('id');
    idKey = 'id';
    return post;
  } catch (err) {
    if (!/unknown|not defined|no field|cannot query|unexpected/i.test(err.message)) throw err;
    const post = await attempt('postId');
    idKey = 'postId';
    return post;
  }
}
