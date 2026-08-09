#!/usr/bin/env node
/**
 * Smoke test for the paths the example run doesn't reach.
 *
 * The example renders with no API keys, so every segment is a placeholder card
 * and the real-footage path — scale, crop, seek, loop — never executes. These
 * tests synthesise local clips with ffmpeg's test sources and push them through
 * the same code the pipeline uses.
 *
 *   node test/smoke.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { ffmpeg, probeDuration, probeStreams } from '../src/ffmpeg.js';
import { assemble } from '../src/assemble.js';
import { buildAss, fitToAudio } from '../src/captions.js';
import { ensureDir } from '../src/config.js';

const tmp = ensureDir(fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-smoke-')));
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** Landscape source, like most stock footage. */
async function makeClip(file, { seconds, width, height }) {
  await ffmpeg([
    '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    file,
  ]);
  return file;
}

async function makeAudio(file, seconds) {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-t', String(seconds), '-c:a', 'libmp3lame', file,
  ]);
  return file;
}

console.log('\n  shorts pipeline smoke test\n');

await test('landscape footage is cropped to 1080x1920', async () => {
  const clip = await makeClip(path.join(tmp, 'wide.mp4'), { seconds: 6, width: 1920, height: 1080 });
  const audio = await makeAudio(path.join(tmp, 'a1.mp3'), 4);
  const segments = [{ start: 0, end: 4, text: 'one two three four', clipFile: clip }];
  const ass = path.join(tmp, 'c1.ass');
  fs.writeFileSync(ass, buildAss(segments));
  const out = path.join(tmp, 'crop', 'out.mp4');
  ensureDir(path.dirname(out));

  const result = await assemble({ segments, audioFile: audio, assFile: ass, outFile: out });
  const video = (await probeStreams(out)).find((s) => s.codec_type === 'video');
  assert.equal(video.width, 1080, 'width');
  assert.equal(video.height, 1920, 'height');
  assert.equal(result.placeholders, 0, 'should not fall back to a placeholder');
});

await test('clip shorter than its segment is looped, not frozen', async () => {
  // 1.5s source into a 5s segment: the loop path.
  const clip = await makeClip(path.join(tmp, 'short.mp4'), { seconds: 1.5, width: 1080, height: 1920 });
  const audio = await makeAudio(path.join(tmp, 'a2.mp3'), 5);
  const segments = [{ start: 0, end: 5, text: 'looping clip test', clipFile: clip }];
  const ass = path.join(tmp, 'c2.ass');
  fs.writeFileSync(ass, buildAss(segments));
  const out = path.join(tmp, 'loop', 'out.mp4');
  ensureDir(path.dirname(out));

  await assemble({ segments, audioFile: audio, assFile: ass, outFile: out });
  const duration = await probeDuration(out);
  assert.ok(Math.abs(duration - 5) < 0.35, `expected ~5s, got ${duration}`);
});

await test('mixed real and placeholder segments concat cleanly', async () => {
  const clip = await makeClip(path.join(tmp, 'mix.mp4'), { seconds: 8, width: 1280, height: 720 });
  const audio = await makeAudio(path.join(tmp, 'a3.mp3'), 9);
  const segments = [
    { start: 0, end: 3, text: 'first segment here', clipFile: clip },
    { start: 3, end: 6, text: 'second has no footage' },
    { start: 6, end: 9, text: 'third segment again', clipFile: clip },
  ];
  const ass = path.join(tmp, 'c3.ass');
  fs.writeFileSync(ass, buildAss(segments));
  const out = path.join(tmp, 'mixed', 'out.mp4');
  ensureDir(path.dirname(out));

  const result = await assemble({ segments, audioFile: audio, assFile: ass, outFile: out });
  assert.equal(result.placeholders, 1, 'one placeholder expected');
  const duration = await probeDuration(out);
  assert.ok(Math.abs(duration - 9) < 0.35, `expected ~9s, got ${duration}`);
  const video = (await probeStreams(out)).find((s) => s.codec_type === 'video');
  assert.equal(video.height, 1920);
});

await test('timings rescale onto the real audio duration', () => {
  const planned = [
    { start: 0, end: 4, text: 'a' },
    { start: 4, end: 10, text: 'b' },
  ];
  const fitted = fitToAudio(planned, 20);
  assert.equal(fitted.at(-1).end, 20, 'last segment must end at the audio duration');
  assert.equal(fitted[0].end, 8, 'boundaries scale proportionally');
  assert.equal(fitted[1].start, 8, 'no gap opens at the boundary');
});

await test('captions tile a segment without gaps or overruns', () => {
  const ass = buildAss([{ start: 0, end: 6, text: 'one two three four five six seven eight nine' }]);
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.ok(lines.length >= 3, `expected several caption chunks, got ${lines.length}`);
  const times = lines.map((l) => l.split(',').slice(1, 3));
  assert.equal(times[0][0], '0:00:00.00', 'first caption starts at zero');
  assert.equal(times.at(-1)[1], '0:00:06.00', 'last caption ends at the segment end');
  for (let i = 1; i < times.length; i += 1) {
    assert.equal(times[i][0], times[i - 1][1], `caption ${i} must start when ${i - 1} ends`);
  }
});

await test('long words wrap instead of overflowing the frame', () => {
  const ass = buildAss([{ start: 0, end: 3, text: 'an extraordinarily complicated assessment' }]);
  assert.ok(ass.includes('WrapStyle: 0'), 'wrapping must be enabled');
  const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  // No chunk should be long enough to overrun 900px of usable width.
  for (const line of dialogue) {
    const text = line.split(',,').at(-1).replace(/\{[^}]*\}/g, '');
    assert.ok(text.length <= 22, `chunk too long to fit: "${text}"`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n  ${failures} failing\n` : '\n  all passing\n');
process.exit(failures ? 1 : 0);
