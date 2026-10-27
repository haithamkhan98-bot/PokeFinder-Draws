import sharp from 'sharp';

/**
 * Synthetic product photos for the self test.
 *
 * Each one is a coloured block sitting inside a wide white margin, in a
 * different shape from its neighbours. That is the awkward case the real
 * pipeline has to survive: the margin must be trimmed away, and the leftover
 * shape padded to the template's frame, or the picture ends up cropped.
 * Getting a visibly correct grid out of these means the geometry is right.
 */
const SHAPES = [
  { w: 800, h: 1000, colour: '#2f5d9e' },
  { w: 1200, h: 800, colour: '#b4472f' },
  { w: 900, h: 900, colour: '#3f7d4a' },
  { w: 700, h: 1150, colour: '#6d4b9c' },
  { w: 1000, h: 620, colour: '#c08a20' },
];

const PRICES = ['$79.94', '$24.99', '$119.94', '$8.49', '$39.99'];

async function samplePhoto({ w, h, colour }, label) {
  // An eighth of the frame as white margin on each side, the way retailers pad.
  const padX = Math.round(w / 8);
  const padY = Math.round(h / 8);
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<rect x="${padX}" y="${padY}" width="${innerW}" height="${innerH}" fill="${colour}" rx="24"/>`
    + `<text x="${w / 2}" y="${h / 2}" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 4)}"`
    + ` fill="#ffffff" text-anchor="middle" dominant-baseline="central">${label}</text>`
    + `</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

/** n fake draw items, shaped like the real ones the fire handler passes on. */
export async function sampleItems(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const shape = SHAPES[i % SHAPES.length];
    items.push({
      pid: `selftest-${i + 1}`,
      productName: `Self Test Item ${i + 1}`,
      rawTitle: `Self Test Item ${i + 1}`,
      priceDisplay: PRICES[i % PRICES.length],
      buffer: await samplePhoto(shape, String(i + 1)),
      shape: `${shape.w}x${shape.h}`,
    });
  }
  return items;
}
