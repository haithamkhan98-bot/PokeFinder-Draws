import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `page` escapes its body and wraps it in a paragraph; `pageHtml` does not
 * escape. Passing markup to `page` renders the tags as visible text, which is
 * not a crash and not caught by any other test: the route answers 200, the
 * page loads, and it simply looks broken.
 *
 * It has now happened twice, once on the bookmarklet page and once on its own
 * error branch, so it gets a test rather than more care.
 */
test('no page() call passes markup, since page() escapes', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const offenders = [];
  // Each page( call, up to its closing paren at the end of a statement.
  // The lookbehind skips the definition of page() itself, which of course
  // contains markup. Without it the test fails on the very function it guards.
  for (const m of src.matchAll(/(?<!function )\bpage\(res,[\s\S]{0,400}?\);/g)) {
    const call = m[0];
    if (/<\w+[\s>]|<\/\w+>/.test(call)) offenders.push(call.replace(/\s+/g, ' ').slice(0, 110));
  }
  assert.deepEqual(offenders, [], `page() called with markup:\n${offenders.join('\n')}`);
});

/**
 * The bookmarklet runs on target.com and calls this service, which is cross
 * origin. A plain GET is sent regardless, so a missing header does not stop
 * the save, it only withholds the reply: the bookmarklet says "Failed to
 * fetch" about a request that worked. Every exit from that route therefore
 * needs the header, including the refusals, or a wrong key reports as a
 * network failure and sends HK looking in the wrong place.
 */
test('every response from /target/close allows cross origin reads', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = src.indexOf("if (path === '/target/close')");
  assert.ok(start > 0, 'route not found');
  const route = src.slice(start, src.indexOf("if (path === '/canva/connect')", start));
  const writes = [...route.matchAll(/res\.writeHead\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(writes.length >= 4, `expected several exits, saw ${writes.length}`);
  const missing = writes.filter((w) => !w.includes('CORS'));
  assert.deepEqual(missing, [], `exits without CORS:\n${missing.join('\n')}`);
});
