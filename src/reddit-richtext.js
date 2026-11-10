/**
 * Markdown to Reddit's RTJSON.
 *
 * Reddit's submit endpoint takes EITHER a markdown `text` field or a
 * `richtext_json` document, never both, and only the richtext form can carry
 * an image alongside formatted text. The web editor sends richtext, which is
 * why a post made by hand has the grid image and the affiliate links together.
 * So the bot sends richtext too.
 *
 * This converts the small markdown subset reddit-copy.js actually produces
 * rather than being a general parser: paragraphs, whole-line bold headings,
 * `*` bullet lists, and inline [text](url) links. Anything it does not
 * recognise passes through as plain text, which is the right failure: a post
 * with a stray asterisk still reads, a post that threw does not go out at all.
 *
 * Keeping it pure and separate from the HTTP client matters because this is
 * the half that can be tested without Reddit credentials.
 */

/** Reddit's inline format codes. Only bold is used by the copy. */
const BOLD = 1;

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * One line of markdown to an array of richtext inline elements.
 *
 * Links become their own `link` elements rather than formatting ranges on a
 * text run, which is how the editor emits them. Bold is a formatting range on
 * the text it covers, given as [code, start, length] in UTF-16 code units.
 */
export function inlines(line) {
  const out = [];
  let rest = String(line ?? '');

  // Links first: a link's label can contain no further markup in this copy, so
  // splitting on them leaves plain segments that only need bold handling.
  let last = 0;
  const parts = [];
  for (const m of rest.matchAll(LINK)) {
    if (m.index > last) parts.push({ text: rest.slice(last, m.index) });
    parts.push({ link: { t: m[1], u: m[2] } });
    last = m.index + m[0].length;
  }
  if (last < rest.length) parts.push({ text: rest.slice(last) });
  if (!parts.length) parts.push({ text: '' });

  for (const part of parts) {
    if (part.link) { out.push({ e: 'link', t: part.link.t, u: part.link.u }); continue; }
    const { text, ranges } = bold(part.text);
    if (!text) continue;
    out.push(ranges.length ? { e: 'text', t: text, f: ranges } : { e: 'text', t: text });
  }
  return out.length ? out : [{ e: 'text', t: '' }];
}

/**
 * Strip **markers** and report where the bold runs are.
 *
 * Offsets are into the stripped text, since that is what Reddit renders. An
 * unclosed marker is left as literal asterisks rather than bolding the rest of
 * the line, which is what a reader would expect from a typo.
 */
export function bold(raw) {
  const s = String(raw ?? '');
  let text = '';
  const ranges = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const close = s.indexOf('**', i + 2);
      if (close === -1) { text += s.slice(i); break; }
      const inner = s.slice(i + 2, close);
      if (inner.length) ranges.push([BOLD, text.length, inner.length]);
      text += inner;
      i = close + 2;
      continue;
    }
    text += s[i];
    i += 1;
  }
  return { text, ranges };
}

const par = (line) => ({ e: 'par', c: inlines(line) });
const isBullet = (l) => /^\s*[*-]\s+/.test(l);
const bulletText = (l) => l.replace(/^\s*[*-]\s+/, '');

/**
 * A markdown body to an RTJSON document.
 *
 * `imageAssetId` comes from Reddit's media upload and goes in first, matching
 * where the editor puts an image dragged to the top of a post.
 */
export function toRichtext(markdown, { imageAssetId = null, caption = null } = {}) {
  const document = [];
  if (imageAssetId) {
    document.push(caption
      ? { e: 'img', id: imageAssetId, c: caption }
      : { e: 'img', id: imageAssetId });
  }

  const lines = String(markdown ?? '').split('\n');
  let list = null;

  const closeList = () => { if (list) { document.push(list); list = null; } };

  for (const line of lines) {
    if (!line.trim()) { closeList(); continue; }

    if (isBullet(line)) {
      // Consecutive bullets are one list. Reddit renders each list as its own
      // block, so letting a blank line split them would show two lists where
      // the copy means one.
      list = list ?? { e: 'list', o: false, c: [] };
      list.c.push({ e: 'li', c: [par(bulletText(line))] });
      continue;
    }

    closeList();
    document.push(par(line));
  }
  closeList();

  return { document };
}
