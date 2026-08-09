import fs from 'node:fs';
import path from 'node:path';
import { VIDEO, ensureDir } from './config.js';
import { ffmpeg, probeDuration } from './ffmpeg.js';

const SCALE_CHAIN = [
  `scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=increase`,
  `crop=${VIDEO.width}:${VIDEO.height}`,
  `fps=${VIDEO.fps}`,
  'setsar=1',
  'format=yuv420p',
].join(',');

// Muted, desaturated backdrops for segments with no footage. Cycled so two
// consecutive placeholders don't look like one long static shot.
const PLACEHOLDER_COLOURS = ['0x141E30', '0x2B1B3D', '0x102A2E', '0x2E1F14', '0x1B2438'];

/**
 * Render one segment to a normalised, silent 1080x1920 clip.
 *
 * Everything is forced to identical codec/resolution/framerate/SAR here so the
 * concat demuxer can stitch without re-encoding decisions per file — mismatched
 * SAR is the usual cause of concat producing a stretched or black output.
 */
async function renderSegment(segment, index, workDir) {
  const out = path.join(workDir, `seg-${String(index).padStart(3, '0')}.mp4`);
  const duration = Math.max(0.4, segment.end - segment.start);

  if (!segment.clipFile) {
    const colour = PLACEHOLDER_COLOURS[index % PLACEHOLDER_COLOURS.length];
    await ffmpeg([
      '-f', 'lavfi',
      '-i', `color=c=${colour}:s=${VIDEO.width}x${VIDEO.height}:r=${VIDEO.fps}`,
      '-t', duration.toFixed(3),
      '-c:v', 'libx264', '-preset', VIDEO.preset, '-crf', String(VIDEO.crf),
      '-pix_fmt', 'yuv420p',
      out,
    ]);
    return { file: out, duration, placeholder: true };
  }

  const sourceDuration = await probeDuration(segment.clipFile);
  const args = [];

  if (sourceDuration >= duration + 0.2) {
    // Skip the first half second — stock clips often open on a fade or a
    // camera still settling. Then take from the middle where framing is best.
    const usable = sourceDuration - duration;
    const offset = Math.min(usable, Math.max(0.5, usable * 0.25));
    args.push('-ss', offset.toFixed(3), '-i', segment.clipFile);
  } else {
    // Clip is shorter than the segment: loop it rather than freeze-framing.
    args.push('-stream_loop', '-1', '-i', segment.clipFile);
  }

  args.push(
    '-t', duration.toFixed(3),
    '-an',
    '-vf', SCALE_CHAIN,
    '-c:v', 'libx264', '-preset', VIDEO.preset, '-crf', String(VIDEO.crf),
    '-pix_fmt', 'yuv420p',
    out
  );

  await ffmpeg(args);
  return { file: out, duration, placeholder: false };
}

/**
 * Build the finished MP4: concat the segments, burn the captions, mux the
 * voiceover, and optionally duck a music bed underneath.
 */
export async function assemble({ segments, audioFile, assFile, outFile, musicFile }) {
  const workDir = ensureDir(path.join(path.dirname(outFile), 'work'));
  const rendered = [];

  for (let i = 0; i < segments.length; i += 1) {
    process.stdout.write(`  segment ${i + 1}/${segments.length}\r`);
    rendered.push(await renderSegment(segments[i], i, workDir));
  }
  process.stdout.write('\n');

  const listFile = path.join(workDir, 'concat.txt');
  await fs.promises.writeFile(
    listFile,
    rendered.map((r) => `file '${path.basename(r.file)}'`).join('\n') + '\n'
  );

  const silentVideo = path.join(workDir, 'silent.mp4');
  await ffmpeg(
    ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', 'silent.mp4'],
    { cwd: workDir }
  );

  // Copy inputs next to the ass file and run from that directory. libass paths
  // inside a filtergraph need escaping for ':' and '\' — sidestepping it with
  // a relative filename is far more robust than getting the escaping right.
  const localAss = path.join(workDir, 'captions.ass');
  if (path.resolve(assFile) !== path.resolve(localAss)) {
    await fs.promises.copyFile(assFile, localAss);
  }

  const args = ['-i', 'silent.mp4', '-i', path.resolve(audioFile)];
  const useMusic = Boolean(musicFile && fs.existsSync(musicFile));

  if (useMusic) args.push('-stream_loop', '-1', '-i', path.resolve(musicFile));

  // One filtergraph for everything. Mixing -vf with -filter_complex in the
  // same command is where this kind of pipeline usually starts misbehaving.
  const graph = ['[0:v]ass=captions.ass[v]'];
  if (useMusic) {
    // Music sits far under the voice — at this level it reads as texture
    // rather than as a second thing competing for attention.
    graph.push('[2:a]volume=0.12[bed]');
    graph.push('[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0[aout]');
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[v]');
  args.push('-map', useMusic ? '[aout]' : '1:a');

  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(VIDEO.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-shortest',
    '-movflags', '+faststart',
    path.resolve(outFile)
  );

  await ffmpeg(args, { cwd: workDir });

  return {
    outFile,
    duration: await probeDuration(outFile),
    placeholders: rendered.filter((r) => r.placeholder).length,
    workDir,
  };
}
