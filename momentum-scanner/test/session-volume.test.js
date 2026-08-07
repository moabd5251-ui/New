import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expectedVolumeFraction,
  expectedVolumeBy,
  relativeVolume,
  minutesIntoSession,
  SESSION_MINUTES,
} from '../lib/session-volume.js';

test('the curve runs from just above zero to exactly one', () => {
  assert.ok(expectedVolumeFraction(0) > 0, 'never zero — it is a divisor');
  assert.ok(expectedVolumeFraction(0) < 0.01);
  assert.equal(expectedVolumeFraction(SESSION_MINUTES), 1);
  assert.equal(expectedVolumeFraction(SESSION_MINUTES + 60), 1);
});

test('the curve only ever increases', () => {
  let previous = 0;
  for (let minute = 0; minute <= SESSION_MINUTES; minute += 1) {
    const value = expectedVolumeFraction(minute);
    assert.ok(value >= previous, `went backwards at minute ${minute}`);
    previous = value;
  }
});

test('the curve is U-shaped: the open and close are the heavy halves', () => {
  const firstHalfHour = expectedVolumeFraction(30);
  const lunchHalfHour = expectedVolumeFraction(180) - expectedVolumeFraction(150);
  const lastHalfHour = 1 - expectedVolumeFraction(360);

  assert.ok(firstHalfHour > lunchHalfHour * 3, 'the open should dwarf midday');
  assert.ok(lastHalfHour > lunchHalfHour * 3, 'the close should dwarf midday');
  assert.ok(firstHalfHour > 0.1 && firstHalfHour < 0.25);
});

test('known points on the curve', () => {
  assert.ok(Math.abs(expectedVolumeFraction(30) - 0.155) < 1e-9);
  assert.ok(Math.abs(expectedVolumeFraction(180) - 0.45) < 1e-9);
  // Halfway through a bucket interpolates halfway through its share.
  assert.ok(Math.abs(expectedVolumeFraction(15) - 0.0775) < 1e-9);
});

/**
 * The regression this module exists for. The old code pro-rated linearly with a
 * 0.02 floor, which at 09:31 made the baseline ~8x too large — so a genuine 8x
 * runner read as 1x and was filtered out during the exact minutes this strategy
 * trades.
 */
test('a genuine opening-minute runner is not flattened to 1x', () => {
  const avgDaily = 1_000_000;
  const oneMinuteIn = new Date('2026-08-07T13:31:00Z'); // 09:31 ET

  // Typical stock: by 09:31 it has done about half a percent of its day.
  const typicalByNow = avgDaily * expectedVolumeFraction(1);
  assert.equal(relativeVolume(typicalByNow, avgDaily, { live: true, now: oneMinuteIn }), 1);

  // A stock doing 8x that pace must read as 8x, not as 1x.
  const runner = relativeVolume(typicalByNow * 8, avgDaily, { live: true, now: oneMinuteIn });
  assert.ok(runner > 7.5 && runner < 8.5, `expected ~8x, got ${runner}`);

  // The old linear-with-floor model: avgDaily * 0.02 as the baseline.
  const oldModel = (typicalByNow * 8) / (avgDaily * 0.02);
  assert.ok(oldModel < 5, `old model reported ${oldModel.toFixed(2)}x — under the 5x threshold`);
});

test('a naive linear model would over-report the same runner at the open', () => {
  const avgDaily = 1_000_000;
  const volume = 15_000; // 1.5% of the day done in the first minute
  const linear = volume / (avgDaily * (1 / 390)); // no floor: 5.85x
  const curved = relativeVolume(volume, avgDaily, {
    live: true,
    now: new Date('2026-08-07T13:31:00Z'),
  });
  assert.ok(linear > 5, 'linear over-reports');
  assert.ok(curved < linear, `curve (${curved.toFixed(2)}x) must be below linear (${linear.toFixed(2)}x)`);
});

test('a session flagged open outside session hours falls back to a full day', () => {
  // Clock skew, a stub, or an extended session. Dividing by a near-zero
  // baseline would report every stock as a thousand-x runner; under-reporting
  // is the safe direction for a signal that gates trades.
  const beforeBell = new Date('2026-08-07T08:55:00Z'); // 04:55 ET
  assert.equal(expectedVolumeBy(1_000_000, { live: true, now: beforeBell }), 1_000_000);
  assert.equal(relativeVolume(500_000, 1_000_000, { live: true, now: beforeBell }), 0.5);

  const afterClose = new Date('2026-08-07T23:00:00Z'); // 19:00 ET
  assert.equal(expectedVolumeBy(1_000_000, { live: true, now: afterClose }), 1_000_000);
});

test('a closed session compares against a whole average day', () => {
  assert.equal(expectedVolumeBy(1_000_000, { live: false }), 1_000_000);
  assert.equal(relativeVolume(500_000, 1_000_000, { live: false }), 0.5);
});

test('missing inputs yield null rather than a misleading number', () => {
  assert.equal(expectedVolumeBy(null, { live: true }), null);
  assert.equal(expectedVolumeBy(0, { live: true }), null);
  assert.equal(relativeVolume(100, null, { live: true }), null);
  assert.equal(relativeVolume(null, 1_000_000, { live: true }), null);
});

test('minutes into the session are measured in Eastern time', () => {
  // 13:30 UTC is the 09:30 opening bell during daylight saving.
  assert.ok(Math.abs(minutesIntoSession(new Date('2026-08-07T13:30:00Z'))) < 0.02);
  assert.ok(Math.abs(minutesIntoSession(new Date('2026-08-07T16:30:00Z')) - 180) < 0.02);
  // Before the bell it is negative, which the curve clamps.
  assert.ok(minutesIntoSession(new Date('2026-08-07T12:00:00Z')) < 0);
});
