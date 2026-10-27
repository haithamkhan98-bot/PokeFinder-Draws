import sharp from 'sharp';

// Anything below this on any channel counts as content rather than background.
// This is the same threshold used by the browser side trim that produced the
// crops on the hand built draw images, so output matches what came before.
const CONTENT_THRESHOLD = 245;

export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

// The draw canvas background. Padding onto this colour makes the added margin
// invisible against the design.
export const CANVAS_BACKGROUND = { r: 255, g: 249, b: 244, alpha: 1 };

/**
 * Find the bounding box of the non white content in an image.
 *
 * Retailers pad product photos with a wide white margin. Left alone, that
 * padding is what gets scaled to fill a slot, so the product itself ends up
 * small and the grid looks sparse. Trimming first means the slot is filled by
 * the product.
 *
 * Returns normalised coordinates so the caller can reason about aspect ratio
 * without caring about the source resolution.
 */
export async function contentBox(buffer) {
  const img = sharp(buffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let x0 = width, y0 = height, x1 = -1, y1 = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // Fully transparent pixels are background whatever their colour.
      if (channels === 4 && data[i + 3] === 0) continue;
      if (data[i] < CONTENT_THRESHOLD || data[i + 1] < CONTENT_THRESHOLD || data[i + 2] < CONTENT_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  if (x1 < 0) return null; // the whole image is background

  return {
    width, height,
    left: x0, top: y0,
    cropWidth: x1 - x0 + 1,
    cropHeight: y1 - y0 + 1,
    x0: x0 / width,
    y0: y0 / height,
    x1: (x1 + 1) / width,
    y1: (y1 + 1) / height,
    aspect: (x1 - x0 + 1) / (y1 - y0 + 1),
  };
}

/** Crop an image down to its content and return a PNG. */
export async function trimToContent(buffer) {
  const box = await contentBox(buffer);
  if (!box) return { buffer: await sharp(buffer).png().toBuffer(), box: null, trimmed: false };

  const out = await sharp(buffer)
    .extract({ left: box.left, top: box.top, width: box.cropWidth, height: box.cropHeight })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { buffer: out, box, trimmed: true };
}

/**
 * Fetch a product photo and trim it.
 *
 * Walmart's CDN is fine, but this runs unattended so it refuses anything that
 * is not actually an image, or is implausibly large, rather than passing a
 * surprise downstream into Canva.
 */
export async function fetchAndTrim(url, { timeoutMs = 20_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`image fetch returned ${res.status}`);

    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new Error(`expected an image, got ${type || 'no content type'}`);

    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.byteLength > MAX_SOURCE_BYTES) throw new Error(`image is ${raw.byteLength} bytes, over the limit`);

    const { buffer, box, trimmed } = await trimToContent(raw);
    return { buffer, box, trimmed, sourceBytes: raw.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pad an image out to a target aspect ratio, centred, on the canvas colour.
 *
 * Canva autofill drops an image into a frame of fixed proportions and fills it,
 * which crops anything that does not match. Every product photo is a different
 * shape, so without this the tall boxes would lose their tops and bottoms.
 * Padding to the frame's exact ratio first means the fill is a pure scale with
 * nothing cut off, and the added margin is invisible against the background.
 */
export async function padToAspect(buffer, targetAspect = 1, background = CANVAS_BACKGROUND) {
  const meta = await sharp(buffer).metadata();
  const { width, height } = meta;
  const current = width / height;

  let outW = width, outH = height;
  if (current < targetAspect) outW = Math.round(height * targetAspect);
  else if (current > targetAspect) outH = Math.round(width / targetAspect);
  if (outW === width && outH === height) return buffer;

  return sharp(buffer)
    .extend({
      left: Math.floor((outW - width) / 2),
      right: Math.ceil((outW - width) / 2),
      top: Math.floor((outH - height) / 2),
      bottom: Math.ceil((outH - height) / 2),
      background,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Trim a product photo to its content, then pad it to the frame's shape. */
export async function prepareForSlot(buffer, targetAspect = 1) {
  const { buffer: trimmed, box, trimmed: didTrim } = await trimToContent(buffer);
  const padded = await padToAspect(trimmed, targetAspect);
  const meta = await sharp(padded).metadata();
  return { buffer: padded, box, trimmed: didTrim, width: meta.width, height: meta.height };
}
