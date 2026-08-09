import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE } from './config.js';

const run = promisify(execFile);

/**
 * ffmpeg writes progress to stderr and exits non-zero on real failures, so we
 * surface the tail of stderr rather than the whole log — the useful error is
 * always in the last few lines.
 */
export async function ffmpeg(args, { cwd } = {}) {
  try {
    return await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`ffmpeg failed:\n${detail}`);
  }
}

export async function probeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function probeStreams(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=width,height,codec_type,duration',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(stdout).streams || [];
}
