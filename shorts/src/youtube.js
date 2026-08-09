import fs from 'node:fs';
import { getAccessToken } from './google-auth.js';

/**
 * YouTube Data API v3 — resumable video upload.
 *
 * Resumable rather than simple upload because a Short is small but a dropped
 * connection halfway through still costs the full 1600 quota units, and the
 * default quota only allows about six uploads a day.
 */

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API_URL = 'https://www.googleapis.com/youtube/v3';

// Must be a multiple of 256 KiB — the API rejects anything else on a
// non-final chunk. 8 MiB is a reasonable balance of round trips and retry cost.
export const CHUNK_SIZE = 8 * 1024 * 1024;

export const QUOTA_COST_UPLOAD = 1600;
export const DEFAULT_DAILY_QUOTA = 10_000;

// Shorts are vertical and at most 3 minutes.
export const SHORTS_MAX_SECONDS = 180;

export const CATEGORIES = {
  film: '1',
  music: '10',
  pets: '15',
  sports: '17',
  travel: '19',
  gaming: '20',
  people: '22',
  comedy: '23',
  entertainment: '24',
  news: '25',
  howto: '26',
  education: '27',
  science: '28',
};

/**
 * Byte range for the next chunk. `end` is inclusive, as Content-Range requires
 * — the classic off-by-one in resumable uploads.
 */
export function nextChunk(offset, total, chunkSize = CHUNK_SIZE) {
  if (offset >= total) return null;
  const length = Math.min(chunkSize, total - offset);
  const end = offset + length - 1;
  return {
    start: offset,
    end,
    length,
    contentRange: `bytes ${offset}-${end}/${total}`,
  };
}

/**
 * A 308 response reports what the server has, as `bytes=0-N` where N is the
 * last byte received. The next offset is N+1. A missing header means nothing
 * has been stored yet.
 */
export function parseRangeHeader(header) {
  if (!header) return 0;
  const match = /bytes=(\d+)-(\d+)/.exec(header);
  if (!match) return 0;
  return Number.parseInt(match[2], 10) + 1;
}

export function validateMetadata(meta) {
  const problems = [];
  if (!meta.title || !meta.title.trim()) problems.push('title is required');
  if (meta.title && meta.title.length > 100) {
    problems.push(`title is ${meta.title.length} chars; the limit is 100`);
  }
  if (meta.title && /[<>]/.test(meta.title)) {
    problems.push('title cannot contain < or > (YouTube rejects the upload)');
  }
  if (meta.description && meta.description.length > 5000) {
    problems.push(`description is ${meta.description.length} chars; the limit is 5000`);
  }
  if (meta.tags && meta.tags.join('').length > 500) {
    problems.push('tags exceed the 500 character total');
  }
  if (meta.privacyStatus && !['private', 'unlisted', 'public'].includes(meta.privacyStatus)) {
    problems.push(`invalid privacy "${meta.privacyStatus}"`);
  }
  if (meta.publishAt) {
    if (meta.privacyStatus !== 'private') {
      problems.push('publishAt requires privacy "private" — YouTube ignores it otherwise');
    }
    if (Number.isNaN(Date.parse(meta.publishAt))) {
      problems.push(`publishAt "${meta.publishAt}" is not a valid ISO 8601 timestamp`);
    }
  }
  return problems;
}

export function buildRequestBody(meta) {
  const body = {
    snippet: {
      title: meta.title,
      description: meta.description || '',
      categoryId: meta.categoryId || CATEGORIES.education,
    },
    status: {
      privacyStatus: meta.privacyStatus || 'private',
      selfDeclaredMadeForKids: Boolean(meta.madeForKids),
      // Required disclosure for realistic altered or synthetic content.
      // Added to the API in October 2024.
      containsSyntheticMedia: Boolean(meta.containsSyntheticMedia),
    },
  };
  if (meta.tags && meta.tags.length) body.snippet.tags = meta.tags;
  if (meta.defaultLanguage) body.snippet.defaultLanguage = meta.defaultLanguage;
  if (meta.publishAt) body.status.publishAt = new Date(meta.publishAt).toISOString();
  if (meta.license) body.status.license = meta.license;
  return body;
}

async function apiError(res) {
  const text = await res.text();
  let message = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message || message;
    const reason = parsed.error?.errors?.[0]?.reason;
    if (reason) message += ` (${reason})`;
  } catch {
    if (text) message += `: ${text.slice(0, 300)}`;
  }
  return new Error(message);
}

export async function getChannel() {
  const token = await getAccessToken();
  const url = `${API_URL}/channels?part=snippet,statistics&mine=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  const channel = data.items?.[0];
  if (!channel) return null;
  return {
    id: channel.id,
    title: channel.snippet?.title,
    subscribers: channel.statistics?.subscriberCount,
    videos: channel.statistics?.videoCount,
  };
}

async function startSession(body, fileSize) {
  const token = await getAccessToken();
  const url = `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(fileSize),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
  const location = res.headers.get('location');
  if (!location) throw new Error('no upload session URI returned');
  return location;
}

/** Ask the server how much it already has, so a retry resumes rather than restarts. */
async function queryOffset(sessionUri, total) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${total}` },
  });
  if (res.status === 308) return parseRangeHeader(res.headers.get('range'));
  if (res.ok) return total;
  throw await apiError(res);
}

async function readChunk(handle, chunk) {
  const buffer = Buffer.alloc(chunk.length);
  await handle.read(buffer, 0, chunk.length, chunk.start);
  return buffer;
}

export async function uploadVideo({ file, metadata, onProgress, maxRetries = 5 }) {
  const problems = validateMetadata(metadata);
  if (problems.length) {
    throw new Error(`invalid metadata:\n  - ${problems.join('\n  - ')}`);
  }

  const total = fs.statSync(file).size;
  if (!total) throw new Error(`${file} is empty`);

  const sessionUri = await startSession(buildRequestBody(metadata), total);
  const handle = await fs.promises.open(file, 'r');

  try {
    let offset = 0;
    let attempts = 0;

    while (offset < total) {
      const chunk = nextChunk(offset, total);
      const body = await readChunk(handle, chunk);

      let res;
      try {
        const token = await getAccessToken();
        res = await fetch(sessionUri, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Length': String(chunk.length),
            'Content-Range': chunk.contentRange,
          },
          body,
        });
      } catch (err) {
        // Network-level failure. Ask where the server got to and resume there.
        attempts += 1;
        if (attempts > maxRetries) throw new Error(`upload failed after ${maxRetries} retries: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2 ** attempts * 1000));
        offset = await queryOffset(sessionUri, total);
        continue;
      }

      if (res.status === 308) {
        attempts = 0;
        offset = parseRangeHeader(res.headers.get('range')) || chunk.end + 1;
        if (onProgress) onProgress(offset, total);
        continue;
      }

      if (res.ok) {
        if (onProgress) onProgress(total, total);
        return await res.json();
      }

      // 5xx is transient; anything else is a real rejection and retrying it
      // would just burn quota.
      if (res.status >= 500) {
        attempts += 1;
        if (attempts > maxRetries) throw await apiError(res);
        await new Promise((r) => setTimeout(r, 2 ** attempts * 1000));
        offset = await queryOffset(sessionUri, total);
        continue;
      }

      throw await apiError(res);
    }

    throw new Error('upload ended without a response from YouTube');
  } finally {
    await handle.close();
  }
}
