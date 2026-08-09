#!/usr/bin/env node
/**
 * Tests for the uploader's pure logic — chunk arithmetic, resume offsets,
 * metadata assembly and validation. No network, no credentials.
 *
 *   node test/upload.js
 */
import assert from 'node:assert/strict';
import {
  nextChunk,
  parseRangeHeader,
  validateMetadata,
  buildRequestBody,
  CHUNK_SIZE,
  CATEGORIES,
} from '../src/youtube.js';
import {
  buildCredits,
  buildDescription,
  decideSyntheticMedia,
  suggestTags,
} from '../src/metadata.js';
import { extractCode } from '../src/google-auth.js';

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('\n  uploader tests\n');

test('chunk ranges are inclusive and tile the file exactly', () => {
  const total = CHUNK_SIZE * 2 + 1234;
  let offset = 0;
  const ranges = [];
  let chunk;
  while ((chunk = nextChunk(offset, total))) {
    ranges.push(chunk);
    offset = chunk.end + 1;
  }
  assert.equal(ranges.length, 3);
  assert.equal(ranges[0].contentRange, `bytes 0-${CHUNK_SIZE - 1}/${total}`);
  assert.equal(ranges[1].start, CHUNK_SIZE, 'second chunk starts where the first ended + 1');
  assert.equal(ranges.at(-1).end, total - 1, 'last byte is total-1, not total');
  assert.equal(ranges.reduce((s, r) => s + r.length, 0), total, 'lengths sum to the file size');
});

test('a file smaller than one chunk is a single range', () => {
  const chunk = nextChunk(0, 500);
  assert.equal(chunk.length, 500);
  assert.equal(chunk.contentRange, 'bytes 0-499/500');
  assert.equal(nextChunk(500, 500), null, 'no chunk once the offset reaches the size');
});

test('308 Range header maps to the next byte offset', () => {
  // Server has bytes 0..262143, so the next byte to send is 262144.
  assert.equal(parseRangeHeader('bytes=0-262143'), 262144);
  assert.equal(parseRangeHeader(null), 0, 'no header means nothing stored yet');
  assert.equal(parseRangeHeader('nonsense'), 0);
});

test('metadata validation catches the limits YouTube enforces', () => {
  assert.deepEqual(validateMetadata({ title: 'ok' }), []);
  assert.match(validateMetadata({ title: 'x'.repeat(101) })[0], /limit is 100/);
  assert.match(validateMetadata({ title: 'a <b>' })[0], /cannot contain/);
  assert.match(validateMetadata({ title: 'a', description: 'x'.repeat(5001) })[0], /5000/);
  assert.match(validateMetadata({ title: 'a', tags: ['x'.repeat(501)] })[0], /500 character/);
  assert.match(validateMetadata({ title: 'a', privacyStatus: 'secret' })[0], /invalid privacy/);
});

test('publishAt is rejected unless privacy is private', () => {
  const bad = validateMetadata({
    title: 'a',
    privacyStatus: 'public',
    publishAt: '2030-01-01T00:00:00Z',
  });
  assert.ok(bad.some((p) => /requires privacy "private"/.test(p)));

  const good = validateMetadata({
    title: 'a',
    privacyStatus: 'private',
    publishAt: '2030-01-01T00:00:00Z',
  });
  assert.deepEqual(good, []);

  const malformed = validateMetadata({
    title: 'a',
    privacyStatus: 'private',
    publishAt: 'next tuesday',
  });
  assert.ok(malformed.some((p) => /ISO 8601/.test(p)));
});

test('request body defaults to private and always states the synthetic flag', () => {
  const body = buildRequestBody({ title: 'T' });
  assert.equal(body.status.privacyStatus, 'private');
  assert.equal(body.status.containsSyntheticMedia, false);
  assert.equal(body.status.selfDeclaredMadeForKids, false);
  assert.equal(body.snippet.categoryId, CATEGORIES.education);
  assert.ok(!('tags' in body.snippet), 'empty tags are omitted rather than sent as []');
});

test('publishAt is normalised to ISO 8601', () => {
  const body = buildRequestBody({ title: 'T', publishAt: '2030-06-01T12:00:00+02:00' });
  assert.equal(body.status.publishAt, '2030-06-01T10:00:00.000Z');
});

test('credits deduplicate per author and provider', () => {
  const credits = buildCredits([
    { provider: 'pexels', author: 'Ana' },
    { provider: 'pexels', author: 'Ana' },
    { provider: 'pixabay', author: 'Bo' },
  ]);
  assert.equal(credits, 'Footage:\n- Ana (Pexels)\n- Bo (Pixabay)');
  assert.equal(buildCredits([]), '', 'no credits block when there is no footage');
});

test('description stacks topic, extra text and credits', () => {
  const manifest = {
    topic: 'Why seals mirror people',
    attributions: [{ provider: 'pexels', author: 'Ana' }],
  };
  const description = buildDescription(manifest, { extra: 'Subscribe for more.' });
  assert.equal(
    description,
    'Why seals mirror people\n\nSubscribe for more.\n\nFootage:\n- Ana (Pexels)'
  );
  assert.ok(!buildDescription(manifest, { includeCredits: false }).includes('Footage:'));
});

test('synthetic disclosure triggers on AI clips and on synthetic narration', () => {
  const aiClip = decideSyntheticMedia({
    segments: [{ source: 'stock' }, { source: 'ai' }],
    voice: { provider: 'silence', silent: true },
  });
  assert.equal(aiClip.disclose, true);
  assert.match(aiClip.reasons.join(), /1 AI-generated clip/);

  const ttsOnly = decideSyntheticMedia({
    segments: [{ source: 'stock' }],
    voice: { provider: 'elevenlabs' },
  });
  assert.equal(ttsOnly.disclose, true, 'a synthetic voiceover discloses by default');

  const neither = decideSyntheticMedia({
    segments: [{ source: 'stock' }],
    voice: { provider: 'silence', silent: true },
  });
  assert.equal(neither.disclose, false);

  assert.equal(decideSyntheticMedia(null).disclose, false);
});

test('tags skip stopwords, short words and duplicates', () => {
  const tags = suggestTags({
    title: 'Why the seals copy you',
    topic: 'Seals and the science of mirroring',
  });
  assert.ok(!tags.includes('the'));
  assert.ok(!tags.includes('why'), 'stopwords are dropped');
  assert.ok(tags.includes('seals'));
  assert.equal(new Set(tags).size, tags.length, 'no duplicates');
});

test('auth accepts a pasted redirect URL or a bare code', () => {
  assert.equal(extractCode('http://127.0.0.1:8080/?code=4/abc&scope=x'), '4/abc');
  assert.equal(extractCode('  4/bare-code  '), '4/bare-code');
  assert.throws(
    () => extractCode('http://127.0.0.1:8080/?error=access_denied'),
    /authorisation denied/
  );
});

console.log(failures ? `\n  ${failures} failing\n` : '\n  all passing\n');
process.exit(failures ? 1 : 0);
