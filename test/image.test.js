import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { contentBox, trimToContent } from '../src/image.js';

// A retailer style photo: a 400x400 white canvas with a 100x160 dark block
// sitting off centre, the way Walmart pads its product shots.
async function padded({ w = 400, h = 400, left = 120, top = 90, bw = 100, bh = 160 } = {}) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: bw, height: bh, channels: 3, background: '#1b3a6b' } })
        .png().toBuffer(),
      left, top,
    }])
    .png().toBuffer();
}

test('the content box finds the product and ignores the white padding', async () => {
  const box = await contentBox(await padded());
  assert.equal(box.left, 120);
  assert.equal(box.top, 90);
  assert.equal(box.cropWidth, 100);
  assert.equal(box.cropHeight, 160);
  assert.equal(box.aspect, 100 / 160);
});

test('normalised coordinates match the hand measured ones', async () => {
  const box = await contentBox(await padded());
  assert.equal(box.x0, 0.3);
  assert.equal(box.y0, 0.225);
  assert.equal(box.x1, 0.55);
  assert.equal(box.y1, 0.625);
});

test('trimming returns an image cropped to the product alone', async () => {
  const { buffer, trimmed } = await trimToContent(await padded());
  const meta = await sharp(buffer).metadata();
  assert.equal(trimmed, true);
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 160);
});

test('near white is treated as padding, so off white backgrounds still trim', async () => {
  const img = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fbfbfb' } })
    .composite([{
      input: await sharp({ create: { width: 40, height: 40, channels: 3, background: '#000000' } }).png().toBuffer(),
      left: 80, top: 50,
    }])
    .png().toBuffer();
  const box = await contentBox(img);
  assert.equal(box.cropWidth, 40);
  assert.equal(box.cropHeight, 40);
});

test('an all white image is reported rather than cropped to nothing', async () => {
  const blank = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#ffffff' } })
    .png().toBuffer();
  assert.equal(await contentBox(blank), null);
  const { trimmed } = await trimToContent(blank);
  assert.equal(trimmed, false, 'a blank image must pass through rather than throw');
});

test('transparent padding counts as background', async () => {
  const img = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{
      input: await sharp({ create: { width: 20, height: 30, channels: 3, background: '#aa2222' } }).png().toBuffer(),
      left: 40, top: 35,
    }])
    .png().toBuffer();
  const box = await contentBox(img);
  assert.equal(box.cropWidth, 20);
  assert.equal(box.cropHeight, 30);
});

test('a tall product is padded sideways to a square, never cropped', async () => {
  const { padToAspect } = await import('../src/image.js');
  const tall = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#1b3a6b' } })
    .png().toBuffer();
  const out = await padToAspect(tall, 1);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 200, 'the original height is untouched, width grows to match');
});

test('a wide product is padded vertically instead', async () => {
  const { padToAspect } = await import('../src/image.js');
  const wide = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#1b3a6b' } })
    .png().toBuffer();
  const meta = await sharp(await padToAspect(wide, 1)).metadata();
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 300);
});

test('padding uses the canvas colour so the margin is invisible', async () => {
  const { padToAspect, CANVAS_BACKGROUND } = await import('../src/image.js');
  const tall = await sharp({ create: { width: 50, height: 100, channels: 3, background: '#000000' } })
    .png().toBuffer();
  const out = await padToAspect(tall, 1);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[0], CANVAS_BACKGROUND.r, 'top left pixel should be the canvas colour');
  assert.equal(data[1], CANVAS_BACKGROUND.g);
  assert.equal(data[2], CANVAS_BACKGROUND.b);
});

test('trim then pad gives a square containing the whole product', async () => {
  const { prepareForSlot } = await import('../src/image.js');
  const padded = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: 60, height: 180, channels: 3, background: '#aa2222' } }).png().toBuffer(),
      left: 100, top: 60,
    }])
    .png().toBuffer();
  const out = await prepareForSlot(padded, 1);
  assert.equal(out.box.cropWidth, 60, 'trimmed to the product');
  assert.equal(out.box.cropHeight, 180);
  assert.equal(out.width, 180, 'then squared off');
  assert.equal(out.height, 180);
});
