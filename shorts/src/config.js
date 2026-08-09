import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const CACHE_DIR = path.join(ROOT, '.cache', 'stock');
export const OUT_DIR = path.join(ROOT, 'out');

export const FFMPEG = ffmpegStatic;
export const FFPROBE = ffprobeStatic.path;

// Vertical 1080x1920 is what YouTube wants for Shorts. 30fps keeps file sizes
// sane; stock footage is rarely shot above it anyway.
export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  crf: 20,
  preset: 'veryfast',
};

// Narration pace used to estimate segment timings before the real voiceover
// exists. Measured against typical Shorts voiceovers, which run fast.
export const WORDS_PER_SECOND = 2.6;

/**
 * Minimal .env reader. Deliberately not pulling in dotenv — this package has
 * exactly two dependencies and it's worth keeping it that way.
 */
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'short';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
