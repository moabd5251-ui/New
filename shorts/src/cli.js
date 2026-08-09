#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, slugify, ensureDir, OUT_DIR, CACHE_DIR } from './config.js';
import { synthesize } from './tts.js';
import { fetchClip, hasStockKeys } from './stock.js';
import { buildAss, fitToAudio } from './captions.js';
import { assemble } from './assemble.js';

function parseArgs(argv) {
  const opts = { input: null, music: null, out: null, skipStock: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--music') opts.music = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--no-stock') opts.skipStock = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else rest.push(arg);
  }
  opts.input = rest[0] || null;
  return opts;
}

function usage() {
  console.log(`
  make-short — build a vertical Short from a shot list

  Usage:
    npm run make -- <shot-list.json> [options]

  Options:
    --music <file>   background music bed, mixed low under the voiceover
    --out <file>     output path (default: out/<slug>/<slug>.mp4)
    --no-stock       skip footage lookup, render placeholder cards only
    --help

  The shot list JSON is what prompts/03-shot-list.md produces.
`);
}

function validate(shotList) {
  const problems = [];
  if (!shotList.voice_script) problems.push('missing "voice_script"');
  if (!Array.isArray(shotList.segments) || !shotList.segments.length) {
    problems.push('missing or empty "segments"');
    return problems;
  }
  shotList.segments.forEach((s, i) => {
    if (typeof s.start !== 'number' || typeof s.end !== 'number') {
      problems.push(`segment ${i}: start/end must be numbers`);
    } else if (s.end <= s.start) {
      problems.push(`segment ${i}: end (${s.end}) must be after start (${s.start})`);
    }
    if (!s.text) problems.push(`segment ${i}: missing "text"`);
    if (i > 0) {
      const prev = shotList.segments[i - 1];
      if (Math.abs(s.start - prev.end) > 0.05) {
        problems.push(`segment ${i}: starts at ${s.start} but segment ${i - 1} ends at ${prev.end} — segments must tile without gaps`);
      }
    }
  });
  return problems;
}

/** Warn when the model paraphrased while segmenting — this desyncs captions. */
function checkScriptMatch(shotList) {
  const normalise = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const joined = normalise(shotList.segments.map((s) => s.text).join(' '));
  const script = normalise(shotList.voice_script);
  return joined === script;
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.input) {
    usage();
    process.exit(opts.input ? 0 : 1);
  }

  if (!fs.existsSync(opts.input)) {
    console.error(`Shot list not found: ${opts.input}`);
    process.exit(1);
  }

  let shotList;
  try {
    // Tolerate a markdown fence, since models add one even when told not to.
    const raw = fs.readFileSync(opts.input, 'utf8').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
    shotList = JSON.parse(raw);
  } catch (err) {
    console.error(`Shot list is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const problems = validate(shotList);
  if (problems.length) {
    console.error('Shot list is invalid:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const slug = slugify(shotList.title || shotList.topic || 'short');
  const workRoot = ensureDir(path.join(OUT_DIR, slug));
  const outFile = opts.out || path.join(workRoot, `${slug}.mp4`);
  ensureDir(CACHE_DIR);

  console.log(`\n  ${shotList.title || slug}`);
  console.log(`  ${shotList.segments.length} segments, planned ${shotList.segments.at(-1).end.toFixed(1)}s\n`);

  if (!checkScriptMatch(shotList)) {
    console.warn('  ! segment text does not reconstruct voice_script exactly.');
    console.warn('    captions will not match the voiceover. Re-run prompt 03.\n');
  }

  // 1. Voiceover first — its real duration drives every other timing.
  console.log('  [1/4] voiceover');
  const audioFile = path.join(workRoot, 'voice.mp3');
  const voice = await synthesize(shotList.voice_script, audioFile);
  console.log(`        ${voice.provider}${voice.voice ? ` (${voice.voice})` : ''} — ${voice.duration.toFixed(2)}s`);
  if (voice.silent) {
    console.warn('        ! no TTS provider configured; the track is silent.');
    console.warn('        ! set ELEVENLABS_API_KEY or OPENAI_API_KEY in .env for real audio.');
  }

  const segments = fitToAudio(shotList.segments, voice.duration);
  const planned = shotList.segments.at(-1).end;
  if (Math.abs(voice.duration - planned) > 0.75) {
    console.log(`        timings rescaled ${planned.toFixed(1)}s -> ${voice.duration.toFixed(1)}s to match audio`);
  }

  // 2. Footage.
  console.log('  [2/4] footage');
  const attributions = [];
  const used = new Set();

  if (opts.skipStock) {
    console.log('        skipped (--no-stock)');
  } else if (!hasStockKeys()) {
    console.warn('        ! no PEXELS_API_KEY or PIXABAY_API_KEY; using placeholder cards.');
  } else {
    for (const [i, segment] of segments.entries()) {
      const query = segment.stock_query || segment.clip || segment.text;
      const need = segment.end - segment.start;
      const clip = segment.source === 'ai' ? null : await fetchClip(query, Math.min(need, 3), { used });
      if (clip) {
        segment.clipFile = clip.file;
        attributions.push({
          segment: i,
          query,
          matched: clip.matchedQuery,
          provider: clip.provider,
          author: clip.author,
          url: clip.pageUrl,
        });
        console.log(`        ${i + 1}. "${query}" -> ${clip.provider}/${clip.author}${clip.broadened ? ` (broadened to "${clip.matchedQuery}")` : ''}`);
      } else {
        const why = segment.source === 'ai' ? 'marked source:"ai"' : 'no match';
        console.log(`        ${i + 1}. "${query}" -> placeholder (${why})`);
      }
    }
  }

  // 3. Captions.
  console.log('  [3/4] captions');
  const assFile = path.join(workRoot, 'captions.ass');
  fs.writeFileSync(assFile, buildAss(segments));

  // 4. Assembly.
  console.log('  [4/4] assembly');
  const result = await assemble({
    segments,
    audioFile,
    assFile,
    outFile,
    musicFile: opts.music,
  });

  const manifest = {
    title: shotList.title,
    topic: shotList.topic,
    generatedAt: new Date().toISOString(),
    duration: result.duration,
    voice: { provider: voice.provider, voice: voice.voice, silent: Boolean(voice.silent) },
    segments: segments.map((s, i) => ({
      index: i,
      start: Number(s.start.toFixed(3)),
      end: Number(s.end.toFixed(3)),
      text: s.text,
      clip: s.clip,
      stock_query: s.stock_query,
      source: s.source || 'stock',
      sourced: Boolean(s.clipFile),
    })),
    attributions,
    placeholders: result.placeholders,
  };
  fs.writeFileSync(path.join(workRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n  done — ${outFile}`);
  console.log(`  ${result.duration.toFixed(2)}s, ${size} MB, ${result.placeholders} placeholder segment(s)`);

  if (attributions.length) {
    console.log('\n  Credits (paste into the video description):');
    const lines = [...new Set(attributions.map((a) => `  ${a.author} (${a.provider})`))];
    for (const line of lines) console.log(line);
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n  failed: ${err.message}\n`);
  process.exit(1);
});
