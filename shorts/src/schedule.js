import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { QUOTA_COST_UPLOAD, DEFAULT_DAILY_QUOTA } from './youtube.js';

/**
 * Scheduling logic: when each queued video posts, and whether there is enough
 * API quota left today to upload it.
 *
 * Everything here is pure apart from the state file read/write at the bottom,
 * so the slot arithmetic and quota accounting can be tested against fixed
 * clocks rather than whatever time the suite happens to run at.
 */

export const STATE_FILE = path.join(ROOT, '.schedule.json');
export const QUEUE_DIR = path.join(ROOT, 'queue');

export const STATUS = {
  pending: 'pending',   // queued, not yet rendered
  rendered: 'rendered', // MP4 exists, waiting for its slot / quota
  uploaded: 'uploaded', // sent to YouTube
  failed: 'failed',     // gave up; needs a look
};

const MAX_ATTEMPTS = 3;

export function defaultConfig(env = process.env) {
  return {
    // Local times of day to post at.
    slots: parseSlotTimes(env.SCHEDULE_SLOTS || '09:00,18:00'),
    maxPerDay: Number.parseInt(env.SCHEDULE_MAX_PER_DAY || '2', 10),
    // "drip" holds the upload until the slot comes round.
    // "publish-at" uploads early and lets YouTube publish at the slot.
    //
    // Defaults to drip because publish-at schedules a publish that never fires
    // while the API project is unaudited — the video is locked to private the
    // moment it arrives. Switch to publish-at once the audit clears.
    mode: (env.SCHEDULE_MODE || 'drip').toLowerCase(),
    // Only used in drip mode; publish-at always ends up public.
    privacy: env.SCHEDULE_PRIVACY || 'private',
    quotaBudget: Number.parseInt(env.SCHEDULE_QUOTA_BUDGET || String(DEFAULT_DAILY_QUOTA), 10),
    category: env.SCHEDULE_CATEGORY || 'education',
  };
}

export function parseSlotTimes(value) {
  const times = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(s);
      if (!match) throw new Error(`invalid slot time "${s}" — use HH:MM`);
      const h = Number.parseInt(match[1], 10);
      const m = Number.parseInt(match[2], 10);
      if (h > 23 || m > 59) throw new Error(`invalid slot time "${s}"`);
      return { h, m };
    });
  if (!times.length) throw new Error('no slot times configured');
  return times.sort((a, b) => a.h - b.h || a.m - b.m);
}

/**
 * The quota day, which is not the calendar day.
 *
 * YouTube resets API quota at midnight Pacific regardless of where you are, so
 * bucketing spend by local date would let a run just after local midnight
 * double-spend the same Pacific day.
 */
export function quotaDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function remainingQuota(state, now = new Date(), budget = DEFAULT_DAILY_QUOTA) {
  const key = quotaDayKey(now);
  const spent = state.quota?.[key] || 0;
  return Math.max(0, budget - spent);
}

export function canUpload(state, now = new Date(), budget = DEFAULT_DAILY_QUOTA) {
  return remainingQuota(state, now, budget) >= QUOTA_COST_UPLOAD;
}

export function recordQuota(state, now = new Date(), cost = QUOTA_COST_UPLOAD) {
  const key = quotaDayKey(now);
  state.quota = state.quota || {};
  state.quota[key] = (state.quota[key] || 0) + cost;
  // Keep the ledger from growing without bound.
  const keys = Object.keys(state.quota).sort();
  while (keys.length > 30) delete state.quota[keys.shift()];
  return state;
}

/**
 * The next `count` free posting slots after `now`.
 *
 * A slot already assigned to another job is skipped but still counts against
 * that day's cap. A slot that has simply passed unused does not — a missed
 * morning post shouldn't reduce how many you can publish that evening.
 */
export function nextFreeSlots(now, times, maxPerDay, count, taken = new Set()) {
  const out = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);

  for (let day = 0; day < 400 && out.length < count; day += 1) {
    let usedToday = 0;
    for (const { h, m } of times) {
      const slot = new Date(cursor);
      slot.setHours(h, m, 0, 0);
      const key = slot.toISOString();

      if (taken.has(key)) {
        usedToday += 1;
        continue;
      }
      if (slot.getTime() <= now.getTime()) continue;
      if (usedToday >= maxPerDay) continue;

      out.push(slot);
      usedToday += 1;
      if (out.length >= count) break;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function takenSlots(jobs) {
  return new Set(jobs.filter((j) => j.slot).map((j) => new Date(j.slot).toISOString()));
}

/**
 * Give every unscheduled job a slot, and move any job whose slot has passed
 * without it going out to the next free one.
 *
 * The reschedule matters for cron: if the machine was asleep, or a run failed,
 * jobs would otherwise sit with a slot in the past forever — and in publish-at
 * mode a past publishAt is rejected by the API outright.
 */
export function assignSlots(state, config, now = new Date()) {
  const changes = [];
  const active = state.jobs.filter((j) => j.status !== STATUS.uploaded && j.status !== STATUS.failed);

  const stale = active.filter((j) => j.slot && new Date(j.slot).getTime() <= now.getTime());
  for (const job of stale) job.slot = null;

  const unscheduled = active.filter((j) => !j.slot);
  if (!unscheduled.length) return changes;

  const slots = nextFreeSlots(
    now,
    config.slots,
    config.maxPerDay,
    unscheduled.length,
    takenSlots(state.jobs.filter((j) => j.slot))
  );

  unscheduled.forEach((job, i) => {
    if (!slots[i]) return;
    const wasStale = stale.includes(job);
    job.slot = slots[i].toISOString();
    changes.push({ id: job.id, slot: job.slot, rescheduled: wasStale });
  });

  return changes;
}

export function isDue(job, now = new Date()) {
  return Boolean(job.slot) && new Date(job.slot).getTime() <= now.getTime();
}

/**
 * Privacy and publishAt for a job, given the mode.
 *
 * publish-at hands the timing to YouTube: upload private now, with a publishAt
 * that flips it public at the slot. drip keeps the timing here and uploads at
 * the slot with whatever privacy is configured.
 */
export function uploadPlanFor(job, config) {
  if (config.mode === 'publish-at') {
    return { privacyStatus: 'private', publishAt: job.slot, becomesPublic: true };
  }
  return { privacyStatus: config.privacy, publishAt: null, becomesPublic: config.privacy === 'public' };
}

/** True when this configuration will make videos publicly visible. */
export function publishesPublicly(config) {
  return config.mode === 'publish-at' || config.privacy === 'public' || config.privacy === 'unlisted';
}

export function shouldAttempt(job) {
  return (job.attempts || 0) < MAX_ATTEMPTS;
}

export function markFailure(job, message) {
  job.attempts = (job.attempts || 0) + 1;
  job.error = message;
  if (!shouldAttempt(job)) job.status = STATUS.failed;
  return job;
}

// --- state persistence ---

export function emptyState() {
  return { version: 1, jobs: [], quota: {} };
}

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...emptyState(), ...state };
  } catch {
    return emptyState();
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function nextId(state) {
  const highest = state.jobs.reduce((max, j) => Math.max(max, Number.parseInt(j.id, 10) || 0), 0);
  return String(highest + 1);
}

export function addJob(state, shotListPath, title) {
  const job = {
    id: nextId(state),
    source: shotListPath,
    title: title || path.basename(shotListPath, '.json'),
    status: STATUS.pending,
    slot: null,
    renderDir: null,
    videoId: null,
    attempts: 0,
    error: null,
    addedAt: new Date().toISOString(),
    uploadedAt: null,
  };
  state.jobs.push(job);
  return job;
}
