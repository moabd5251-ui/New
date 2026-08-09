#!/usr/bin/env node
import fs from 'node:fs';
import { loadEnv } from './config.js';
import { probeDuration, probeStreams } from './ffmpeg.js';
import { hasCredentials } from './google-auth.js';
import {
  uploadVideo,
  getChannel,
  validateMetadata,
  buildRequestBody,
  CATEGORIES,
  SHORTS_MAX_SECONDS,
  QUOTA_COST_UPLOAD,
  DEFAULT_DAILY_QUOTA,
} from './youtube.js';
import {
  resolveRender,
  buildDescription,
  decideSyntheticMedia,
  suggestTags,
} from './metadata.js';

function parseArgs(argv) {
  const opts = { tags: null, synthetic: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--title': opts.title = argv[++i]; break;
      case '--description': opts.description = argv[++i]; break;
      case '--tags': opts.tags = argv[++i].split(',').map((t) => t.trim()).filter(Boolean); break;
      case '--privacy': opts.privacy = argv[++i]; break;
      case '--publish-at': opts.publishAt = argv[++i]; break;
      case '--category': opts.category = argv[++i]; break;
      case '--made-for-kids': opts.madeForKids = true; break;
      case '--synthetic': opts.synthetic = true; break;
      case '--no-synthetic': opts.synthetic = false; break;
      case '--no-credits': opts.noCredits = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: rest.push(arg);
    }
  }
  opts.target = rest[0] || null;
  return opts;
}

function usage() {
  console.log(`
  upload — publish a rendered Short to YouTube

  Usage:
    npm run upload -- <render-dir-or-mp4> [options]

  Reads manifest.json next to the video, when present, to fill in the title,
  the description (including footage credits) and the synthetic-media
  disclosure. Anything passed explicitly wins.

  Options:
    --title <text>          override the title (<=100 chars)
    --description <text>    extra text, prepended above the credits block
    --tags a,b,c            keyword tags (500 chars total)
    --privacy <status>      private (default) | unlisted | public
    --publish-at <iso>      schedule; requires --privacy private
    --category <name|id>    ${Object.keys(CATEGORIES).join(', ')} (default: education)
    --made-for-kids         declare the video as made for kids
    --synthetic             force the altered/synthetic content disclosure on
    --no-synthetic          force it off
    --no-credits            omit the footage credits block
    --dry-run               print the exact request body and stop
    --yes, -y               required to upload as unlisted or public

  Each upload costs ${QUOTA_COST_UPLOAD} of the default ${DEFAULT_DAILY_QUOTA.toLocaleString()} daily quota units
  (about six per day).
`);
}

function resolveCategory(value) {
  if (!value) return CATEGORIES.education;
  if (/^\d+$/.test(value)) return value;
  const id = CATEGORIES[value.toLowerCase()];
  if (!id) throw new Error(`unknown category "${value}" — one of: ${Object.keys(CATEGORIES).join(', ')}`);
  return id;
}

function bar(done, total, width = 28) {
  const ratio = total ? done / total : 0;
  const filled = Math.round(ratio * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${(ratio * 100).toFixed(0)}%`;
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.target) {
    usage();
    process.exit(opts.target ? 0 : 1);
  }

  const { video, manifest } = resolveRender(opts.target);

  // Shape checks. Neither is fatal — YouTube accepts the upload either way,
  // it just will not be treated as a Short.
  const [duration, streams] = await Promise.all([probeDuration(video), probeStreams(video)]);
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const warnings = [];
  if (videoStream && videoStream.width >= videoStream.height) {
    warnings.push(`${videoStream.width}x${videoStream.height} is not vertical; it will not be shown as a Short`);
  }
  if (duration > SHORTS_MAX_SECONDS) {
    warnings.push(`${duration.toFixed(0)}s exceeds the ${SHORTS_MAX_SECONDS}s Shorts limit`);
  }
  if (manifest?.voice?.silent) {
    warnings.push('the voiceover track is silent — this render had no TTS provider configured');
  }
  if (manifest?.placeholders) {
    warnings.push(`${manifest.placeholders} segment(s) are placeholder colour cards, not footage`);
  }

  const synthetic = decideSyntheticMedia(manifest);
  const disclose = opts.synthetic === null ? synthetic.disclose : opts.synthetic;

  const metadata = {
    title: opts.title || manifest?.title || 'Untitled',
    description: buildDescription(manifest, {
      extra: opts.description,
      includeCredits: !opts.noCredits,
    }),
    tags: opts.tags || suggestTags(manifest),
    categoryId: resolveCategory(opts.category),
    privacyStatus: opts.privacy || 'private',
    publishAt: opts.publishAt,
    madeForKids: Boolean(opts.madeForKids),
    containsSyntheticMedia: disclose,
  };

  const problems = validateMetadata(metadata);
  if (problems.length) {
    console.error('\n  Metadata is invalid:');
    for (const p of problems) console.error(`    - ${p}`);
    console.error('');
    process.exit(1);
  }

  const sizeMb = (fs.statSync(video).size / 1024 / 1024).toFixed(1);

  console.log(`\n  ${video}`);
  console.log(`  ${duration.toFixed(1)}s · ${videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown'} · ${sizeMb} MB\n`);
  console.log(`  Title      ${metadata.title}`);
  console.log(`  Privacy    ${metadata.privacyStatus}${metadata.publishAt ? ` (scheduled ${metadata.publishAt})` : ''}`);
  console.log(`  Category   ${metadata.categoryId}`);
  console.log(`  Tags       ${metadata.tags.length ? metadata.tags.join(', ') : '(none)'}`);
  console.log(`  Kids       ${metadata.madeForKids ? 'yes' : 'no'}`);
  console.log(`  Synthetic  ${disclose ? 'disclosed' : 'not disclosed'}${synthetic.reasons.length ? ` — ${synthetic.reasons.join(', ')}` : ''}`);

  if (metadata.description) {
    console.log('\n  Description:');
    for (const line of metadata.description.split('\n')) console.log(`    ${line}`);
  }

  if (warnings.length) {
    console.log('\n  Warnings:');
    for (const w of warnings) console.log(`    ! ${w}`);
  }

  if (opts.dryRun) {
    console.log('\n  Request body:');
    console.log(JSON.stringify(buildRequestBody(metadata), null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('\n  Dry run — nothing was uploaded.\n');
    return;
  }

  // Publishing beyond "private" is outward-facing and effectively permanent
  // once the video is indexed, so it takes an explicit flag rather than a
  // default. Checked before credentials so you find out you need --yes without
  // having to authorise first.
  if (metadata.privacyStatus !== 'private' && !opts.yes) {
    console.error(`\n  Refusing to upload as "${metadata.privacyStatus}" without --yes.`);
    console.error('  Re-run with --yes once the details above are what you want.\n');
    process.exit(1);
  }

  if (!hasCredentials()) {
    console.error('\n  Not authorised. Run: npm run auth\n');
    process.exit(1);
  }

  const channel = await getChannel();
  if (channel) {
    console.log(`\n  Uploading to: ${channel.title} (${channel.id})`);
  }

  let lastPrinted = -1;
  const result = await uploadVideo({
    file: video,
    metadata,
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPrinted) {
        lastPrinted = pct;
        process.stdout.write(`  ${bar(done, total)}\r`);
      }
    },
  });
  process.stdout.write('\n');

  const id = result.id;
  console.log(`\n  Uploaded: https://youtu.be/${id}`);
  console.log(`  Studio:   https://studio.youtube.com/video/${id}/edit`);
  console.log(`  Status:   ${result.status?.privacyStatus}${result.status?.uploadStatus ? ` / ${result.status.uploadStatus}` : ''}`);

  if (result.status?.privacyStatus === 'private' && metadata.privacyStatus !== 'private') {
    console.log('\n  ! YouTube returned "private" despite the requested privacy.');
    console.log('  ! This is the unverified-API-project lock. It cannot be appealed');
    console.log('  ! and the video must be re-uploaded once the project is audited.');
    console.log('  ! See the Verification section of the README.');
  }

  console.log(`\n  Quota used: ~${QUOTA_COST_UPLOAD} units of ${DEFAULT_DAILY_QUOTA.toLocaleString()}/day\n`);
}

main().catch((err) => {
  console.error(`\n  upload failed: ${err.message}\n`);
  process.exit(1);
});
