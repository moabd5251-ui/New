#!/usr/bin/env node
/**
 * Scheduling tests. Every case pins an explicit clock — a scheduler that only
 * passes its tests between 9am and 6pm is not tested.
 *
 *   node test/schedule.js
 */
import assert from 'node:assert/strict';
import {
  parseSlotTimes,
  nextFreeSlots,
  quotaDayKey,
  remainingQuota,
  canUpload,
  recordQuota,
  assignSlots,
  isDue,
  uploadPlanFor,
  publishesPublicly,
  defaultConfig,
  emptyState,
  addJob,
  nextId,
  markFailure,
  shouldAttempt,
  STATUS,
} from '../src/schedule.js';

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** Local-time helper so expectations read the way slots are configured. */
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const hhmm = (date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

console.log('\n  scheduler tests\n');

test('slot times parse, validate and sort', () => {
  assert.deepEqual(parseSlotTimes('18:00,09:30'), [{ h: 9, m: 30 }, { h: 18, m: 0 }]);
  assert.throws(() => parseSlotTimes('9am'), /use HH:MM/);
  assert.throws(() => parseSlotTimes('25:00'), /invalid slot time/);
  assert.throws(() => parseSlotTimes(''), /no slot times/);
});

test('slots run forward from now, never into the past', () => {
  const now = at(2026, 8, 9, 12, 0); // midday, between a 09:00 and an 18:00 slot
  const slots = nextFreeSlots(now, parseSlotTimes('09:00,18:00'), 2, 3);
  assert.equal(slots.length, 3);
  assert.equal(hhmm(slots[0]), '18:00', 'the 09:00 slot today has already gone');
  assert.equal(slots[0].getDate(), 9);
  assert.equal(hhmm(slots[1]), '09:00');
  assert.equal(slots[1].getDate(), 10, 'next is the following morning');
  assert.ok(slots.every((s) => s > now));
});

test('the per-day cap limits posts even with more slot times available', () => {
  const now = at(2026, 8, 9, 0, 30);
  const slots = nextFreeSlots(now, parseSlotTimes('08:00,12:00,16:00,20:00'), 2, 4);
  const firstDay = slots.filter((s) => s.getDate() === 9);
  assert.equal(firstDay.length, 2, 'capped at 2 on day one despite 4 slot times');
  assert.equal(hhmm(firstDay[0]), '08:00');
  assert.equal(hhmm(firstDay[1]), '12:00');
  assert.equal(slots[2].getDate(), 10, 'the rest roll to the next day');
});

test('an already-taken slot is skipped but still spends that day capacity', () => {
  const now = at(2026, 8, 9, 6, 0);
  const taken = new Set([at(2026, 8, 9, 9, 0).toISOString()]);
  const slots = nextFreeSlots(now, parseSlotTimes('09:00,18:00'), 2, 2, taken);
  assert.equal(hhmm(slots[0]), '18:00', 'the taken 09:00 is not handed out twice');
  assert.equal(slots[1].getDate(), 10, 'and it still counted toward the 2/day cap');
});

test('a missed slot does not consume that day capacity', () => {
  // 09:00 passed unused; with a cap of 2 the evening slot must still be free.
  const now = at(2026, 8, 9, 10, 0);
  const slots = nextFreeSlots(now, parseSlotTimes('09:00,18:00'), 2, 1);
  assert.equal(hhmm(slots[0]), '18:00');
  assert.equal(slots[0].getDate(), 9);
});

test('quota buckets by Pacific day, not local day', () => {
  // 05:00 UTC on 10 Aug is still 9 Aug in Los Angeles.
  const lateUtc = new Date('2026-08-10T05:00:00Z');
  const laterUtc = new Date('2026-08-10T18:00:00Z');
  assert.equal(quotaDayKey(lateUtc), '2026-08-09');
  assert.equal(quotaDayKey(laterUtc), '2026-08-10');
  assert.notEqual(quotaDayKey(lateUtc), quotaDayKey(laterUtc));
});

test('quota accounting spends, blocks and resets across the Pacific boundary', () => {
  const state = emptyState();
  const day = new Date('2026-08-09T20:00:00Z');
  assert.equal(remainingQuota(state, day, 10000), 10000);

  for (let i = 0; i < 6; i += 1) recordQuota(state, day);
  assert.equal(remainingQuota(state, day, 10000), 400, '6 uploads at 1600 leaves 400');
  assert.equal(canUpload(state, day, 10000), false, 'no room for a seventh');

  const nextDay = new Date('2026-08-11T20:00:00Z');
  assert.equal(canUpload(state, nextDay, 10000), true, 'a new Pacific day starts clean');
});

test('the quota ledger does not grow without bound', () => {
  const state = emptyState();
  for (let i = 0; i < 40; i += 1) {
    recordQuota(state, new Date(Date.UTC(2026, 0, 1 + i, 20)));
  }
  assert.ok(Object.keys(state.quota).length <= 30);
});

test('assignSlots schedules new jobs in queue order', () => {
  const state = emptyState();
  addJob(state, '/a.json', 'A');
  addJob(state, '/b.json', 'B');
  addJob(state, '/c.json', 'C');
  const config = { ...defaultConfig(), slots: parseSlotTimes('09:00,18:00'), maxPerDay: 2 };
  const now = at(2026, 8, 9, 7, 0);

  assignSlots(state, config, now);
  const slots = state.jobs.map((j) => new Date(j.slot));
  assert.equal(hhmm(slots[0]), '09:00');
  assert.equal(hhmm(slots[1]), '18:00');
  assert.equal(slots[2].getDate(), 10, 'third job rolls past the daily cap');
  assert.equal(new Set(state.jobs.map((j) => j.slot)).size, 3, 'no two jobs share a slot');
});

test('a slot that passed is moved forward, not left in the past', () => {
  const state = emptyState();
  const job = addJob(state, '/a.json', 'A');
  job.slot = at(2026, 8, 8, 9, 0).toISOString(); // yesterday
  const config = { ...defaultConfig(), slots: parseSlotTimes('09:00,18:00'), maxPerDay: 2 };
  const now = at(2026, 8, 9, 12, 0);

  const changes = assignSlots(state, config, now);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].rescheduled, true);
  assert.ok(new Date(state.jobs[0].slot) > now, 'the new slot is in the future');
  assert.equal(hhmm(new Date(state.jobs[0].slot)), '18:00');
});

test('uploaded and failed jobs are left alone', () => {
  const state = emptyState();
  const done = addJob(state, '/a.json', 'A');
  done.status = STATUS.uploaded;
  done.slot = at(2026, 8, 1, 9, 0).toISOString();
  const dead = addJob(state, '/b.json', 'B');
  dead.status = STATUS.failed;
  dead.slot = at(2026, 8, 1, 18, 0).toISOString();

  const config = { ...defaultConfig(), slots: parseSlotTimes('09:00'), maxPerDay: 1 };
  const changes = assignSlots(state, config, at(2026, 8, 9, 12, 0));
  assert.equal(changes.length, 0);
  assert.equal(state.jobs[0].slot, at(2026, 8, 1, 9, 0).toISOString(), 'history is preserved');
});

test('isDue compares against the slot', () => {
  const job = { slot: at(2026, 8, 9, 18, 0).toISOString() };
  assert.equal(isDue(job, at(2026, 8, 9, 17, 59)), false);
  assert.equal(isDue(job, at(2026, 8, 9, 18, 0)), true);
  assert.equal(isDue({ slot: null }, new Date()), false);
});

test('publish-at uploads private with a publishAt; drip uses configured privacy', () => {
  const job = { slot: '2026-08-09T18:00:00.000Z' };

  const scheduled = uploadPlanFor(job, { mode: 'publish-at', privacy: 'private' });
  assert.equal(scheduled.privacyStatus, 'private', 'publishAt is only honoured on private uploads');
  assert.equal(scheduled.publishAt, job.slot);
  assert.equal(scheduled.becomesPublic, true);

  const drip = uploadPlanFor(job, { mode: 'drip', privacy: 'unlisted' });
  assert.equal(drip.privacyStatus, 'unlisted');
  assert.equal(drip.publishAt, null, 'drip does not schedule; it uploads at the slot');
});

test('publishesPublicly detects every configuration that leaves private', () => {
  assert.equal(publishesPublicly({ mode: 'publish-at', privacy: 'private' }), true);
  assert.equal(publishesPublicly({ mode: 'drip', privacy: 'public' }), true);
  assert.equal(publishesPublicly({ mode: 'drip', privacy: 'unlisted' }), true);
  assert.equal(publishesPublicly({ mode: 'drip', privacy: 'private' }), false);
});

test('failures retry a bounded number of times then stop', () => {
  const job = { id: '1', status: STATUS.pending, attempts: 0 };
  markFailure(job, 'boom');
  assert.equal(job.attempts, 1);
  assert.equal(shouldAttempt(job), true);
  assert.equal(job.status, STATUS.pending, 'still retryable');

  markFailure(job, 'boom');
  markFailure(job, 'boom');
  assert.equal(shouldAttempt(job), false);
  assert.equal(job.status, STATUS.failed, 'gives up rather than looping forever');
  assert.equal(job.error, 'boom');
});

test('job ids keep incrementing after removals', () => {
  const state = emptyState();
  addJob(state, '/a.json', 'A');
  addJob(state, '/b.json', 'B');
  state.jobs = state.jobs.filter((j) => j.id !== '2');
  assert.equal(nextId(state), '2');

  addJob(state, '/c.json', 'C');
  addJob(state, '/d.json', 'D');
  assert.equal(new Set(state.jobs.map((j) => j.id)).size, state.jobs.length, 'ids stay unique');
});

console.log(failures ? `\n  ${failures} failing\n` : '\n  all passing\n');
process.exit(failures ? 1 : 0);
