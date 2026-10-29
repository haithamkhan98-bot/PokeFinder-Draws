import sharp from 'sharp';
import { trimToContent, CANVAS_BACKGROUND } from './image.js';

// Matched to the hand built Target grids: a 570px box per product, even gaps,
// a small outer margin, and the same background as every other PokeFinder
// image.
export const BOX = 570;
export const GAP = 70;
export const MARGIN = 40;

/**
 * Choose the grid shape for a given number of products.
 *
 * Two things matter and pull against each other: rows should hold roughly
 * equal numbers of items, and the finished canvas should not be a long thin
 * strip. Nine items laid out 4, 4, 1 is balanced badly; seven laid out as a
 * single row of seven is balanced perfectly but unusable. Scoring both
 * together reproduces the layouts already in use: 3 across for three, 3 then 2
 * for five, 4 then 3 for seven, and 3 by 3 for nine.
 */
export const MAX_COLS = 4;

export function layoutFor(n) {
  if (n < 1) throw new Error('a grid needs at least one item');

  let best = null;
  // Capped, or a ten item drop comes out as a 5 by 2 strip at two and a half
  // to one, which Twitter crops in the timeline. Four across keeps every
  // count from ten upwards near square.
  for (let cols = 1; cols <= Math.min(n, MAX_COLS); cols++) {
    const rows = Math.ceil(n / cols);
    const counts = rowCounts(n, cols, rows);

    // The canvas is as wide as the FULLEST row, which after spreading items
    // evenly can be narrower than the column count being tried. Using cols
    // here sizes the canvas for columns that hold nothing.
    const width = Math.max(...counts);
    const balance = width - Math.min(...counts);

    // Compared on a log scale, so a tall column of one is penalised as hard
    // as a long row of one. On a linear scale a 1 by 7 column scores better
    // than 4 then 3, which is plainly wrong.
    const aspect = width / rows;
    const score = balance + Math.abs(Math.log(aspect / 1.5));
    if (!best || score < best.score - 1e-9) best = { cols: width, rows, counts, score };
  }
  return { cols: best.cols, rows: best.rows, counts: best.counts };
}

/**
 * Spread items evenly across the rows rather than filling each one.
 *
 * Ten items over three rows is 4, 3, 3 and not 4, 4, 2: filling greedily
 * leaves a short last row and makes an otherwise good layout score badly.
 */
function rowCounts(n, cols, rows) {
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
}

/** Fit a product inside the box, preserving its shape. */
async function fitted(buffer) {
  const { buffer: trimmed } = await trimToContent(buffer);
  const out = await sharp(trimmed)
    .resize({ width: BOX, height: BOX, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(out).metadata();
  return { buffer: out, width: meta.width, height: meta.height };
}

/**
 * Build the queue grid.
 *
 * Products are trimmed of the retailer's white padding, scaled to fit the box,
 * and centred in their cell. The last row is centred when it holds fewer items
 * than the rest, which is how the hand built grids look. There is no text
 * anywhere on this image, so nothing here has to match a font.
 */
export async function buildGrid(items, { background = CANVAS_BACKGROUND } = {}) {
  const { cols, rows, counts } = layoutFor(items.length);

  const width = MARGIN * 2 + cols * BOX + (cols - 1) * GAP;
  const height = MARGIN * 2 + rows * BOX + (rows - 1) * GAP;

  const prepared = [];
  for (const item of items) prepared.push(await fitted(item.buffer));

  const composites = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const inRow = counts[r];
    const rowWidth = inRow * BOX + (inRow - 1) * GAP;
    const rowLeft = Math.round((width - rowWidth) / 2);

    for (let c = 0; c < inRow; c++, i++) {
      const img = prepared[i];
      const cellLeft = rowLeft + c * (BOX + GAP);
      const cellTop = MARGIN + r * (BOX + GAP);
      composites.push({
        input: img.buffer,
        left: cellLeft + Math.round((BOX - img.width) / 2),
        top: cellTop + Math.round((BOX - img.height) / 2),
      });
    }
  }

  const png = await sharp({ create: { width, height, channels: 4, background } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { buffer: png, width, height, cols, rows, counts };
}
