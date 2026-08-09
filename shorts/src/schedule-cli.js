#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ensureDir, ROOT } from './config.js';
import { loadShotList, validateShotList, renderShortList } from './render.js';
import { hasCredentials } from './google-auth.js';
import { uploadVideo, QUOTA_COST_UPLOAD, CATEGORIES } from './youtube.js';
import { resolveRender, buildDescription, decideSyntheticMedia, suggestTags } from './metadata.js';
import {
  STATE_FILE, QUEUE_DIR, STATUS,
  defaultConfig, loadState, saveState, addJob,
  assignSlots, isDue, uploadPlanFor, publishesPublicly,
  canUpload, remainingQuota, recordQuota, quotaDayKey,
  markFailure, shouldAttempt,
} from './schedule.js';

function usage() {
  console.log(`
  schedule — queue Shorts and post them on a timetable

  Usage:
    npm run schedule -- <command> [options]

  Commands:
    add <shot-list.json>...   queue one or more shot lists
    list                      show the queue and each job's state
    plan                      show what posts when
    tick                      do whatever is due now (this is what cron runs)
    watch [--every <min>]     run tick on a loop in the foreground
    remove <id>...            drop jobs from the queue
    retry <id>...             reset failed jobs to be tried again

  Options for tick / watch:
    --yes            required when the configuration publishes publicly
    --dry-run        report what would happen, change nothing
    --render-only    render due work but never upload

  Configuration (.env):
    SCHEDULE_SLOTS=09:00,18:00     local times of day to post at
    SCHEDULE_MAX_PER_DAY=2         cap on posts per day
    SCHEDULE_MODE=drip             drip | publish-at
    SCHEDULE_PRIVACY=private       drip mode only
    SCHEDULE_CATEGORY=education
    SCHEDULE_QUOTA_BUDGET=10000    raise if Google granted you more

  drip holds the upload until the slot arrives, which needs a live cron but
  keeps everything in your control. publish-at uploads early and lets YouTube
  flip the video public at its slot, so nothing needs to be running at post
  time — but it does nothing until your API project passes Google's audit.
`);
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function parseFlags(argv) {
  const flags = { every: 5 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--render-only') flags.renderOnly = true;
    else if (arg === '--every') flags.every = Number.parseInt(argv[++i], 10);
    else rest.push(arg);
  }
  return { flags, rest };
}

function cmdAdd(rest) {
  if (!rest.length) throw new Error('usage: schedule add <shot-list.json>...');
  const state = loadState();
  const config = defaultConfig();

  for (const file of rest) {
    if (!fs.existsSync(file)) throw new Error(`not found: ${file}`);
    const shotList = loadShotList(file);
    const problems = validateShotList(shotList);
    if (problems.length) {
      throw new Error(`${file} is not a valid shot list:\n  - ${problems.join('\n  - ')}`);
    }
    const job = addJob(state, path.resolve(file), shotList.title);
    console.log(`  queued #${job.id}  ${job.title}`);
  }

  const changes = assignSlots(state, config, new Date());
  saveState(state);

  for (const change of changes) {
    const job = state.jobs.find((j) => j.id === change.id);
    console.log(`  #${change.id} posts ${fmt(job.slot)}`);
  }
  console.log('');
}

function cmdList() {
  const state = loadState();
  if (!state.jobs.length) {
    console.log('\n  Queue is empty. Add one with: npm run schedule -- add <shot-list.json>\n');
    return;
  }
  console.log('');
  console.log('  ID   STATUS     SLOT             TITLE');
  for (const job of state.jobs) {
    const id = `#${job.id}`.padEnd(4);
    const status = job.status.padEnd(10);
    const slot = fmt(job.slot).padEnd(16);
    console.log(`  ${id} ${status} ${slot} ${job.title}`);
    if (job.videoId) console.log(`       https://youtu.be/${job.videoId}`);
    if (job.error) console.log(`       ! ${job.error} (attempt ${job.attempts})`);
  }

  const now = new Date();
  const config = defaultConfig();
  console.log(`\n  Quota today (${quotaDayKey(now)} Pacific): ${remainingQuota(state, now, config.quotaBudget).toLocaleString()} of ${config.quotaBudget.toLocaleString()} units left`);
  console.log(`  That is ${Math.floor(remainingQuota(state, now, config.quotaBudget) / QUOTA_COST_UPLOAD)} more upload(s) today.\n`);
}

function cmdPlan() {
  const state = loadState();
  const config = defaultConfig();
  assignSlots(state, config, new Date());
  saveState(state);

  const upcoming = state.jobs
    .filter((j) => j.status !== STATUS.uploaded && j.status !== STATUS.failed && j.slot)
    .sort((a, b) => new Date(a.slot) - new Date(b.slot));

  console.log(`\n  Mode: ${config.mode} · slots ${config.slots.map((s) => `${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}`).join(', ')} · max ${config.maxPerDay}/day`);
  if (config.mode === 'drip') console.log(`  Privacy: ${config.privacy}`);
  console.log(publishesPublicly(config)
    ? '  This configuration publishes publicly.'
    : '  This configuration keeps everything private.');

  if (!upcoming.length) {
    console.log('\n  Nothing scheduled.\n');
    return;
  }

  console.log('');
  let day = null;
  for (const job of upcoming) {
    const d = new Date(job.slot).toDateString();
    if (d !== day) {
      day = d;
      console.log(`  ${d}`);
    }
    const time = new Date(job.slot).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    console.log(`    ${time}  #${job.id} ${job.title} (${job.status})`);
  }
  console.log('');
}

function cmdRemove(rest) {
  const state = loadState();
  const before = state.jobs.length;
  state.jobs = state.jobs.filter((j) => !rest.includes(j.id));
  saveState(state);
  console.log(`\n  Removed ${before - state.jobs.length} job(s).\n`);
}

function cmdRetry(rest) {
  const state = loadState();
  let count = 0;
  for (const job of state.jobs) {
    if (!rest.includes(job.id)) continue;
    job.status = job.renderDir ? STATUS.rendered : STATUS.pending;
    job.attempts = 0;
    job.error = null;
    job.slot = null;
    count += 1;
  }
  assignSlots(state, defaultConfig(), new Date());
  saveState(state);
  console.log(`\n  Reset ${count} job(s).\n`);
}

async function uploadJob(job, config, now) {
  const { video, manifest } = resolveRender(job.renderDir);
  const plan = uploadPlanFor(job, config);
  const synthetic = decideSyntheticMedia(manifest);

  const metadata = {
    title: manifest?.title || job.title,
    description: buildDescription(manifest),
    tags: suggestTags(manifest),
    categoryId: CATEGORIES[config.category] || CATEGORIES.education,
    privacyStatus: plan.privacyStatus,
    publishAt: plan.publishAt,
    madeForKids: false,
    containsSyntheticMedia: synthetic.disclose,
  };

  const result = await uploadVideo({ file: video, metadata });
  job.videoId = result.id;
  job.status = STATUS.uploaded;
  job.uploadedAt = now.toISOString();
  job.error = null;
  return result;
}

async function cmdTick(flags) {
  const config = defaultConfig();
  const state = loadState();
  const now = new Date();
  const log = (line) => console.log(`  ${line}`);

  const changes = assignSlots(state, config, now);
  for (const change of changes) {
    if (change.rescheduled) log(`#${change.id} slot had passed — moved to ${fmt(change.slot)}`);
  }

  const publicMode = publishesPublicly(config);
  const confirmed = flags.yes || process.env.SCHEDULE_YES === 'true';
  const uploadsAllowed = !flags.renderOnly && !flags.dryRun && (!publicMode || confirmed);

  if (publicMode && !confirmed && !flags.dryRun && !flags.renderOnly) {
    log(`! mode "${config.mode}" publishes publicly; uploads are held back.`);
    log('! pass --yes, or set SCHEDULE_YES=true in .env, to let it post.');
  }

  // Rendering costs nothing but time, so it always runs — that way a video is
  // ready and inspectable well before its slot.
  let rendered = 0;
  for (const job of state.jobs) {
    if (job.status !== STATUS.pending || !shouldAttempt(job)) continue;
    if (flags.dryRun) {
      log(`would render #${job.id} ${job.title}`);
      rendered += 1;
      continue;
    }
    try {
      log(`rendering #${job.id} ${job.title}`);
      const shotList = loadShotList(job.source);
      const result = await renderShortList(shotList, {
        log: () => {},
        warn: (w) => log(`  ! ${w}`),
      });
      job.renderDir = result.workRoot;
      job.status = STATUS.rendered;
      job.error = null;
      rendered += 1;
      log(`  -> ${result.outFile} (${result.duration.toFixed(1)}s, ${result.placeholders} placeholder segment(s))`);
    } catch (err) {
      markFailure(job, `render: ${err.message}`);
      log(`  ! render failed: ${err.message}`);
    }
    saveState(state);
  }

  // Uploads are quota-limited and, in publish-at mode, ordered by slot so the
  // earliest post goes up first if the day's quota runs out mid-queue.
  let uploaded = 0;
  let blocked = false;
  const candidates = state.jobs
    // On a dry run nothing was actually rendered, so include pending jobs too
    // — otherwise the preview never shows the upload plan, which is the half
    // worth previewing.
    .filter((j) => shouldAttempt(j) && (j.status === STATUS.rendered || (flags.dryRun && j.status === STATUS.pending)))
    .filter((j) => (config.mode === 'drip' ? isDue(j, now) : true))
    .sort((a, b) => new Date(a.slot || 0) - new Date(b.slot || 0));

  for (const job of candidates) {
    if (!canUpload(state, now, config.quotaBudget)) {
      log(`quota exhausted for ${quotaDayKey(now)} Pacific — ${candidates.length - uploaded} job(s) wait for the reset`);
      blocked = true;
      break;
    }
    if (flags.dryRun) {
      const plan = uploadPlanFor(job, config);
      log(`would upload #${job.id} as ${plan.privacyStatus}${plan.publishAt ? `, public at ${fmt(plan.publishAt)}` : ''}`);
      uploaded += 1;
      continue;
    }
    if (!uploadsAllowed) {
      blocked = true;
      continue;
    }
    if (!hasCredentials()) {
      log('! not authorised — run: npm run auth');
      blocked = true;
      break;
    }

    try {
      log(`uploading #${job.id} ${job.title}`);
      const result = await uploadJob(job, config, now);
      recordQuota(state, now);
      uploaded += 1;
      log(`  -> https://youtu.be/${result.id} (${result.status?.privacyStatus})`);
      if (job.slot && config.mode === 'publish-at') log(`  -> goes public ${fmt(job.slot)}`);
    } catch (err) {
      // A rejected upload still costs quota, so record it either way.
      recordQuota(state, now);
      markFailure(job, `upload: ${err.message}`);
      log(`  ! upload failed: ${err.message}`);
    }
    saveState(state);
  }

  if (!flags.dryRun) saveState(state);

  if (!rendered && !uploaded && !blocked) log('nothing due');
  return { rendered, uploaded };
}

async function cmdWatch(flags) {
  const every = Math.max(1, flags.every || 5);
  console.log(`\n  Watching. Running tick every ${every} minute(s). Ctrl-C to stop.`);
  console.log('  For an unattended setup, prefer cron:');
  console.log(`    */${every} * * * * cd ${ROOT} && npm run schedule -- tick${flags.yes ? ' --yes' : ''} >> schedule.log 2>&1\n`);

  const run = async () => {
    console.log(`  --- ${new Date().toLocaleString()} ---`);
    try {
      await cmdTick(flags);
    } catch (err) {
      console.error(`  ! tick failed: ${err.message}`);
    }
  };

  await run();
  setInterval(run, every * 60 * 1000);
}

async function main() {
  loadEnv();
  ensureDir(QUEUE_DIR);

  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, rest } = parseFlags(argv.slice(1));

  switch (command) {
    case 'add': cmdAdd(rest); break;
    case 'list': case 'status': cmdList(); break;
    case 'plan': cmdPlan(); break;
    case 'remove': case 'rm': cmdRemove(rest); break;
    case 'retry': cmdRetry(rest); break;
    case 'tick': {
      console.log('');
      await cmdTick(flags);
      console.log('');
      break;
    }
    case 'watch': await cmdWatch(flags); break;
    default: usage(); process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
