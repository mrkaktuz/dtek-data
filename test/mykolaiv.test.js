import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMykolaiv } from '../src/sources/mykolaiv/parse.js';

// Shapes mirror the live off.energy.mk.ua API (sub-queues, 48 half-hour slots,
// active per-day schedules whose `from` is 00:00 Kyiv in UTC).
const raw = {
  preset: {
    queues: [
      { id: 14, name: '1.1' },
      { id: 15, name: '1.2' },
    ],
    slots: [
      { id: 1, start: '00:00:00', end: '00:30:00' },
      { id: 2, start: '00:30:00', end: '01:00:00' },
      { id: 48, start: '23:30:00', end: '00:00:00' }, // ends at 24:00
    ],
  },
  fact: {
    active: [
      {
        from: '2026-06-30T21:00:00.000000Z', // = 2026-07-01 00:00 Kyiv
        to: '2026-07-01T20:59:00.000000Z',
        series: [
          { time_series_id: 1, outage_queue_id: 14, type: 'OFF' },
          { time_series_id: 2, outage_queue_id: 14, type: 'OFF' }, // merges -> 00:00–01:00
          { time_series_id: 48, outage_queue_id: 15, type: 'PROBABLY_OFF' },
          { time_series_id: 1, outage_queue_id: 15, type: 'ON' }, // ignored
        ],
      },
    ],
  },
};

test('normalizeMykolaiv joins queues+slots+series into dated intervals', () => {
  const { groups, schedules } = normalizeMykolaiv(raw);
  assert.deepEqual(groups, ['1.1', '1.2']);

  // 1.1: two adjacent OFF half-hours merge into 00:00–01:00 off/planned.
  const a = schedules['1.1'].intervals;
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'off');
  assert.equal(a[0].type, 'planned');
  assert.equal(a[0].origin, 'fact');
  assert.match(a[0].start, /^2026-07-01T00:00:00\+03:00$/);
  assert.match(a[0].end, /^2026-07-01T01:00:00\+03:00$/);
  assert.equal(schedules['1.1'].name, 'Черга 1.1');
  assert.equal(schedules['1.1'].group, '1');
  assert.equal(schedules['1.1'].subgroup, '1');

  // 1.2: PROBABLY_OFF -> possible; slot 48 ends at 24:00 (next midnight).
  const b = schedules['1.2'].intervals;
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'possible');
  assert.equal(b[0].type, 'possible');
  assert.match(b[0].start, /^2026-07-01T23:30:00\+03:00$/);
  assert.match(b[0].end, /^2026-07-02T00:00:00\+03:00$/);
});

test('normalizeMykolaiv is empty-safe', () => {
  assert.deepEqual(normalizeMykolaiv({}), { groups: [], schedules: {} });
  assert.deepEqual(normalizeMykolaiv({ preset: {}, fact: {} }), { groups: [], schedules: {} });
});
