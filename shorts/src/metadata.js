import fs from 'node:fs';
import path from 'node:path';

/**
 * Turn a render's manifest.json into YouTube video metadata.
 *
 * Kept separate from the CLI and free of I/O beyond reading the manifest, so
 * the description assembly and the synthetic-media decision can be tested
 * without touching the network.
 */

/** Locate the video and manifest given either a directory or an mp4 path. */
export function resolveRender(target) {
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat) throw new Error(`not found: ${target}`);

  if (stat.isDirectory()) {
    const files = fs.readdirSync(target).filter((f) => f.endsWith('.mp4'));
    if (!files.length) throw new Error(`no .mp4 in ${target}`);
    const video = path.join(target, files[0]);
    const manifest = path.join(target, 'manifest.json');
    return {
      video,
      manifest: fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null,
    };
  }

  const manifest = path.join(path.dirname(target), 'manifest.json');
  return {
    video: target,
    manifest: fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null,
  };
}

/**
 * Credits block for the description.
 *
 * Neither Pexels nor Pixabay requires attribution, but the footage was made by
 * people and the manifest already knows who. One line each, deduplicated.
 */
export function buildCredits(attributions = []) {
  if (!attributions.length) return '';
  const seen = new Map();
  for (const a of attributions) {
    const key = `${a.provider}:${a.author}`;
    if (!seen.has(key)) seen.set(key, a);
  }
  const lines = [...seen.values()].map((a) => {
    const provider = a.provider === 'pexels' ? 'Pexels' : 'Pixabay';
    return `- ${a.author} (${provider})`;
  });
  return `Footage:\n${lines.join('\n')}`;
}

/**
 * Decide whether the altered/synthetic content disclosure applies.
 *
 * AI-generated video clips are unambiguous — YouTube lists "generating
 * realistic scenes" as requiring disclosure.
 *
 * A synthetic narration voice is genuinely ambiguous. YouTube's example list
 * includes "synthetically generating a person's voice to narrate a video"
 * under the heading of using a real person's likeness; the common reading is
 * that a generic TTS voice which impersonates nobody falls outside it. We
 * default to disclosing anyway: the cost of a label is small and the cost of
 * an undisclosed-synthetic strike is not.
 */
export function decideSyntheticMedia(manifest) {
  const reasons = [];
  if (!manifest) return { disclose: false, reasons: ['no manifest — cannot tell'] };

  const aiClips = (manifest.segments || []).filter((s) => s.source === 'ai').length;
  if (aiClips) reasons.push(`${aiClips} AI-generated clip(s)`);

  const voice = manifest.voice || {};
  if (!voice.silent && voice.provider && voice.provider !== 'silence') {
    reasons.push(`synthetic voiceover (${voice.provider})`);
  }

  return { disclose: reasons.length > 0, reasons };
}

export function buildDescription(manifest, { extra, includeCredits = true } = {}) {
  const parts = [];
  if (manifest?.topic) parts.push(manifest.topic);
  if (extra) parts.push(extra);
  if (includeCredits && manifest?.attributions?.length) {
    const credits = buildCredits(manifest.attributions);
    if (credits) parts.push(credits);
  }
  return parts.join('\n\n').trim();
}

/** Conservative tags derived from the topic. YouTube ignores most of them anyway. */
export function suggestTags(manifest, limit = 12) {
  const stop = new Set([
    'the', 'and', 'for', 'that', 'with', 'what', 'why', 'how', 'this', 'from',
    'they', 'them', 'their', 'when', 'does', 'was', 'are', 'its', 'it', 'a', 'an',
    'of', 'on', 'in', 'to', 'is', 'at', 'by', 'as', 'or', 'but', 'not',
    'you', 'your', 'has', 'have', 'had', 'been', 'were', 'will', 'would', 'can',
    'about', 'into', 'than', 'then', 'there', 'these', 'those', 'some', 'any',
    'all', 'one', 'two', 'who', 'whose', 'which', 'where', 'more', 'most',
    'actually', 'really', 'just', 'very', 'means', 'thing', 'things',
  ]);
  const source = [manifest?.title, manifest?.topic].filter(Boolean).join(' ').toLowerCase();
  const words = source.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const tags = [];
  for (const word of words) {
    if (word.length < 4 || stop.has(word) || tags.includes(word)) continue;
    tags.push(word);
    if (tags.length >= limit) break;
  }
  return tags;
}
