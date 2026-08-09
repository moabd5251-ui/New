import fs from 'node:fs';
import path from 'node:path';
import { slugify, ensureDir, OUT_DIR, CACHE_DIR } from './config.js';
import { synthesize } from './tts.js';
import { fetchClip, hasStockKeys } from './stock.js';
import { buildAss, fitToAudio } from './captions.js';
import { assemble } from './assemble.js';

/**
 * The render pipeline, as a function.
 *
 * Split out of the CLI so the scheduler can drive it without shelling out to a
 * child process. All progress goes through an injected `log`, so the CLI can
 * print and the scheduler can stay quiet or redirect to a run log.
 */

export function loadShotList(file) {
  // Tolerate a markdown fence, since models add one even when told not to.
  const raw = fs
    .readFileSync(file, 'utf8')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(raw);
}

export function validateShotList(shotList) {
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
        problems.push(
          `segment ${i}: starts at ${s.start} but segment ${i - 1} ends at ${prev.end} — segments must tile without gaps`
        );
      }
    }
  });
  return problems;
}

/** Warn when the model paraphrased while segmenting — this desyncs captions. */
export function checkScriptMatch(shotList) {
  const normalise = (t) =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const joined = normalise(shotList.segments.map((s) => s.text).join(' '));
  return joined === normalise(shotList.voice_script);
}

export async function renderShortList(shotList, options = {}) {
  const {
    outDir = null,
    outFile: outFileOption = null,
    music = null,
    skipStock = false,
    log = () => {},
    warn = () => {},
  } = options;

  const problems = validateShotList(shotList);
  if (problems.length) {
    throw new Error(`invalid shot list:\n  - ${problems.join('\n  - ')}`);
  }

  const slug = slugify(shotList.title || shotList.topic || 'short');
  const workRoot = ensureDir(outDir || path.join(OUT_DIR, slug));
  const outFile = outFileOption || path.join(workRoot, `${slug}.mp4`);
  ensureDir(CACHE_DIR);

  if (!checkScriptMatch(shotList)) {
    warn('segment text does not reconstruct voice_script exactly; captions will not match the voiceover');
  }

  // 1. Voiceover first — its real duration drives every other timing.
  log('[1/4] voiceover');
  const audioFile = path.join(workRoot, 'voice.mp3');
  const voice = await synthesize(shotList.voice_script, audioFile);
  log(`      ${voice.provider}${voice.voice ? ` (${voice.voice})` : ''} — ${voice.duration.toFixed(2)}s`);
  if (voice.silent) warn('no TTS provider configured; the voice track is silent');

  const segments = fitToAudio(shotList.segments, voice.duration);
  const planned = shotList.segments.at(-1).end;
  if (Math.abs(voice.duration - planned) > 0.75) {
    log(`      timings rescaled ${planned.toFixed(1)}s -> ${voice.duration.toFixed(1)}s to match audio`);
  }

  // 2. Footage.
  log('[2/4] footage');
  const attributions = [];
  const used = new Set();

  if (skipStock) {
    log('      skipped');
  } else if (!hasStockKeys()) {
    warn('no PEXELS_API_KEY or PIXABAY_API_KEY; using placeholder cards');
  } else {
    for (const [i, segment] of segments.entries()) {
      const query = segment.stock_query || segment.clip || segment.text;
      const need = segment.end - segment.start;
      const clip =
        segment.source === 'ai' ? null : await fetchClip(query, Math.min(need, 3), { used });
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
        log(`      ${i + 1}. "${query}" -> ${clip.provider}/${clip.author}${clip.broadened ? ` (broadened to "${clip.matchedQuery}")` : ''}`);
      } else {
        const why = segment.source === 'ai' ? 'marked source:"ai"' : 'no match';
        log(`      ${i + 1}. "${query}" -> placeholder (${why})`);
      }
    }
  }

  // 3. Captions.
  log('[3/4] captions');
  const assFile = path.join(workRoot, 'captions.ass');
  fs.writeFileSync(assFile, buildAss(segments));

  // 4. Assembly.
  log('[4/4] assembly');
  const result = await assemble({ segments, audioFile, assFile, outFile, music: undefined, musicFile: music });

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

  return { outFile, workRoot, manifest, voice, attributions, placeholders: result.placeholders, duration: result.duration };
}
