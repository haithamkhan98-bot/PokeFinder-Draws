import { prepareForSlot } from './image.js';
import { uploadAsset, autofillFromDesign, exportDesign, downloadExport } from './canva-api.js';
import { storeImage, setRunImage, setRunDesign } from './db.js';
import { imageUrl } from './server.js';

/**
 * One template per item count.
 *
 * Canva autofill fills named slots; it cannot add or hide them. A draw with
 * three items therefore needs a design that has exactly three, so the layouts
 * are built ahead of time and picked by count. They are overridable by env so
 * a template can be swapped without a deploy.
 */
export const TEMPLATES = {
  1: process.env.CANVA_TEMPLATE_1 || 'DAHZKEBysrY',
  2: process.env.CANVA_TEMPLATE_2 || 'DAHZKB5JPtc',
  3: process.env.CANVA_TEMPLATE_3 || 'DAHZKM53Was',
  4: process.env.CANVA_TEMPLATE_4 || 'DAHZKA2dl10',
  5: process.env.CANVA_TEMPLATE_5 || 'DAHZKOrqov0',
};

/**
 * The shape of each template's product frame.
 *
 * Autofill scales an image to cover its frame and crops the overflow, so a
 * photo is padded to the frame's exact ratio first and nothing is lost. The
 * single item layout uses a tall frame; every multi item layout uses squares.
 */
export const SLOT_ASPECT = { 1: 395.6 / 470, 2: 1, 3: 1, 4: 1, 5: 1 };

export const MAX_ITEMS = Math.max(...Object.keys(TEMPLATES).map(Number));

const ORDINAL = (n) => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
};

const clockTime = (dt) => {
  const h = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
  const suffix = dt.hour < 12 ? 'AM' : 'PM';
  return dt.minute === 0 ? `${h}${suffix}` : `${h}:${dt.toFormat('mm')}${suffix}`;
};

/**
 * The image header, e.g. "Drawing Starts October 26th\n5PM EST / 2PM PST".
 *
 * The zone labels are written EST and PST year round because that is how every
 * PokeFinder post is worded; the times themselves are converted properly, so
 * they stay correct across the daylight saving change either way.
 */
export function headingFor(startsAt) {
  const et = startsAt.setZone('America/New_York');
  const pt = startsAt.setZone('America/Los_Angeles');
  return `Drawing Starts ${et.toFormat('LLLL')} ${ORDINAL(et.day)}\n${clockTime(et)} EST / ${clockTime(pt)} PST`;
}

export const templateFor = (count) => TEMPLATES[count] ?? null;

/**
 * Build the draw image for a fired run and host it on this service.
 *
 * `items` carry the trimmed product photo as `buffer`. Each is padded to the
 * template's frame shape, uploaded, and autofilled into the layout; the export
 * is then pulled down and stored here, so the URL handed to Buffer later
 * belongs to this service and cannot expire.
 */
export async function buildDrawImage({ runId, drawDate, items, startsAt }) {
  const count = items.length;
  const designId = templateFor(count);
  if (!designId) {
    throw new Error(`no draw template for ${count} items (templates exist for 1 to ${MAX_ITEMS})`);
  }

  const aspect = SLOT_ASPECT[count] ?? 1;
  const data = { heading: { type: 'text', text: headingFor(startsAt) } };

  for (const [i, item] of items.entries()) {
    const slot = i + 1;
    if (!item.buffer) throw new Error(`${item.pid} has no product photo, so the image cannot be built`);
    const { buffer } = await prepareForSlot(item.buffer, aspect);
    const assetId = await uploadAsset(buffer, item.productName || item.rawTitle || `draw item ${slot}`);
    data[`product_${slot}_image`] = { type: 'image', asset_id: assetId };
    data[`price_${slot}`] = { type: 'text', text: item.priceDisplay };
  }

  const design = await autofillFromDesign({
    designId,
    title: `Upcoming Walmart Draws ${drawDate}`,
    data,
  });

  const urls = await exportDesign(design.id);
  if (!urls.length) throw new Error('Canva returned no export URL');

  const png = await downloadExport(urls[0]);
  const id = await storeImage(png, { runId, kind: 'draw', mime: 'image/png' });
  const url = imageUrl(id);

  // runId is null for a self test, which builds a real image through the real
  // path but has no run to attach it to.
  if (runId) {
    await setRunDesign(runId, design.id);
    if (url) await setRunImage(runId, url);
  }

  return { designId: design.id, imageId: id, url, bytes: png.byteLength, editUrl: design.urls?.edit_url };
}
