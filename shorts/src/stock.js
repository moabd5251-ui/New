import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, ensureDir } from './config.js';

/**
 * Licensed stock footage.
 *
 * This is the step that replaces "search TikTok and copy the video link".
 * Pexels and Pixabay both licence their video for commercial use including
 * monetised YouTube, with no attribution legally required — we record it
 * anyway, because crediting creators is cheap and the manifest is the only
 * record of where each clip came from.
 *
 * Both APIs are free. Keys:
 *   https://www.pexels.com/api/
 *   https://pixabay.com/api/docs/
 */

const PORTRAIT_TARGET = 1080 / 1920;

function cacheKey(provider, id, ext = 'mp4') {
  return path.join(CACHE_DIR, `${provider}-${id}.${ext}`);
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  ensureDir(path.dirname(dest));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
  await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fs.promises.rename(tmp, dest);
  return dest;
}

/**
 * Score a candidate video file. We want portrait, at least 1080 tall, and the
 * smallest file that clears that bar — bigger renditions cost download time
 * and get cropped away regardless.
 */
function scoreFile(file) {
  const { width, height } = file;
  if (!width || !height) return -Infinity;
  const ratio = width / height;
  const isPortrait = ratio < 1;
  const tallEnough = height >= 1080;
  let score = 0;
  if (isPortrait) score += 100;
  if (tallEnough) score += 50;
  // Prefer aspect close to 9:16 so cropping throws away as little as possible.
  score -= Math.abs(ratio - PORTRAIT_TARGET) * 40;
  // Mild preference for smaller once the bar is cleared.
  score -= height / 10000;
  return score;
}

async function searchPexels(query, minDuration) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const url = new URL('https://api.pexels.com/videos/search');
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('per_page', '10');
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    console.warn(`  ! pexels ${res.status} for "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.videos || [])
    .filter((v) => (v.duration || 0) >= minDuration)
    .map((v) => {
      const files = (v.video_files || []).filter((f) => f.file_type === 'video/mp4');
      if (!files.length) return null;
      const best = files.sort((a, b) => scoreFile(b) - scoreFile(a))[0];
      return {
        provider: 'pexels',
        id: String(v.id),
        url: best.link,
        width: best.width,
        height: best.height,
        duration: v.duration,
        author: v.user?.name || 'unknown',
        pageUrl: v.url,
        score: scoreFile(best),
      };
    })
    .filter(Boolean);
}

async function searchPixabay(query, minDuration) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const url = new URL('https://pixabay.com/api/videos/');
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('safesearch', 'true');
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  ! pixabay ${res.status} for "${query}"`);
    return [];
  }
  const data = await res.json();
  return (data.hits || [])
    .filter((h) => (h.duration || 0) >= minDuration)
    .map((h) => {
      const variants = Object.values(h.videos || {}).filter((v) => v && v.url);
      if (!variants.length) return null;
      const best = variants.sort((a, b) => scoreFile(b) - scoreFile(a))[0];
      return {
        provider: 'pixabay',
        id: String(h.id),
        url: best.url,
        width: best.width,
        height: best.height,
        duration: h.duration,
        author: h.user || 'unknown',
        pageUrl: h.pageURL,
        score: scoreFile(best),
      };
    })
    .filter(Boolean);
}

/**
 * Progressively broaden the query. Stock libraries are much shallower than a
 * social feed, so "grey seal wet sand" returns nothing while "seal" returns
 * fifty usable clips. Dropping leading words is a crude but effective
 * generalisation: stock queries put the specific qualifier first.
 */
function queryLadder(query) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const ladder = [];
  for (let i = 0; i < words.length; i += 1) {
    const candidate = words.slice(i).join(' ');
    if (candidate) ladder.push(candidate);
  }
  return [...new Set(ladder)];
}

/**
 * Find and download one clip for a segment. Returns null when nothing matches
 * anywhere — the caller renders a placeholder card rather than failing, so a
 * single dead query never kills a whole video.
 */
export async function fetchClip(query, minDuration, { used = new Set() } = {}) {
  for (const term of queryLadder(query)) {
    const [pexels, pixabay] = await Promise.all([
      searchPexels(term, minDuration).catch(() => []),
      searchPixabay(term, minDuration).catch(() => []),
    ]);
    const candidates = [...pexels, ...pixabay]
      .filter((c) => !used.has(`${c.provider}:${c.id}`))
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) continue;

    const pick = candidates[0];
    const dest = cacheKey(pick.provider, pick.id);
    try {
      await download(pick.url, dest);
    } catch (err) {
      console.warn(`  ! ${err.message}`);
      continue;
    }
    used.add(`${pick.provider}:${pick.id}`);
    return {
      file: dest,
      provider: pick.provider,
      author: pick.author,
      pageUrl: pick.pageUrl,
      width: pick.width,
      height: pick.height,
      duration: pick.duration,
      matchedQuery: term,
      broadened: term !== query,
    };
  }
  return null;
}

export function hasStockKeys() {
  return Boolean(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY);
}
