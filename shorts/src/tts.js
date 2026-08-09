import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORDS_PER_SECOND } from './config.js';
import { ffmpeg, probeDuration } from './ffmpeg.js';

const run = promisify(execFile);

/**
 * Voiceover generation, in provider order:
 *   1. ElevenLabs  — the "Adam" voice the video recommends lives here
 *   2. OpenAI      — cheaper, decent, fewer voices
 *   3. piper       — local neural TTS, free, needs a downloaded model
 *   4. espeak-ng   — local, robotic, but proves the pipeline
 *   5. silence     — last resort so the render still completes
 *
 * The fallback chain matters: it means you can build and test the whole
 * pipeline with no API keys and no account, then swap in a real voice by
 * setting one environment variable.
 */

function estimateDuration(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, words / WORDS_PER_SECOND);
}

async function which(bin) {
  try {
    const { stdout } = await run('sh', ['-c', `command -v ${bin} || true`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function elevenLabs(text, outFile) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  // Default is "Adam" — the stock voice used across most faceless Shorts.
  const voice = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2 },
    }),
  });
  if (!res.ok) {
    console.warn(`  ! elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  await fs.promises.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  return { provider: 'elevenlabs', voice };
}

async function openai(text, outFile) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice,
      input: text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    console.warn(`  ! openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  await fs.promises.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  return { provider: 'openai', voice };
}

async function piper(text, outFile) {
  const bin = await which('piper');
  const model = process.env.PIPER_MODEL;
  if (!bin || !model || !fs.existsSync(model)) return null;
  const wav = outFile.replace(/\.mp3$/, '.wav');
  await run('sh', ['-c', `printf %s ${JSON.stringify(text)} | ${bin} --model ${JSON.stringify(model)} --output_file ${JSON.stringify(wav)}`]);
  await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', outFile]);
  await fs.promises.rm(wav, { force: true });
  return { provider: 'piper', voice: path.basename(model) };
}

async function espeak(text, outFile) {
  const bin = (await which('espeak-ng')) || (await which('espeak'));
  if (!bin) return null;
  const wav = outFile.replace(/\.mp3$/, '.wav');
  // 165 wpm approximates the pace of a Shorts voiceover.
  await run(bin, ['-v', 'en-us', '-s', '165', '-w', wav, text]);
  await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', outFile]);
  await fs.promises.rm(wav, { force: true });
  return { provider: 'espeak', voice: 'en-us' };
}

async function silence(text, outFile) {
  const seconds = estimateDuration(text);
  await ffmpeg([
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-t', seconds.toFixed(3),
    '-c:a', 'libmp3lame', '-b:a', '128k',
    outFile,
  ]);
  return { provider: 'silence', voice: null, silent: true };
}

export async function synthesize(text, outFile) {
  const providers = [elevenLabs, openai, piper, espeak];
  for (const provider of providers) {
    try {
      const result = await provider(text, outFile);
      if (result) {
        const duration = await probeDuration(outFile);
        return { ...result, duration, file: outFile };
      }
    } catch (err) {
      console.warn(`  ! tts provider error: ${err.message}`);
    }
  }
  const result = await silence(text, outFile);
  const duration = await probeDuration(outFile);
  return { ...result, duration, file: outFile };
}
