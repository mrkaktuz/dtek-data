/**
 * Normalize the Миколаївобленерго schedule into the shared output schema.
 *
 * Source: the off.energy.mk.ua JSON API (three endpoints, joined here):
 *   /api/outage-queue/by-type/3 -> [{ id, name: "1.1" … "6.2" }]   (sub-queues)
 *   /api/schedule/time-series   -> [{ id, start: "HH:MM:SS", end }] (48 half-hours)
 *   /api/v2/schedule/active     -> [{ from, to, series: [
 *          { time_series_id, outage_queue_id, type } ] }]           (per-day)
 * where `type` is `OFF` (outage) or `PROBABLY_OFF` (possible). `from` is a UTC
 * instant equal to 00:00 Kyiv of the schedule's day; the last slot ends "00:00:00"
 * meaning 24:00. Output shape is identical to the DTEK/ztoe adapters.
 */

import { KIND, OUTAGE_TYPE } from '../../core/schema.js';
import { kyivWallToInstant, kyivDateParts, mergeIntervals, toKyivIso } from '../../core/time.js';

/** API outage type -> interval kind/type, or null when power stays on. */
function typeToInterval(type) {
  switch (String(type)) {
    case 'OFF':
      return { kind: KIND.OFF, type: OUTAGE_TYPE.PLANNED };
    case 'PROBABLY_OFF':
      return { kind: KIND.POSSIBLE, type: OUTAGE_TYPE.POSSIBLE };
    default:
      return null;
  }
}

/** "HH:MM:SS" -> minutes from midnight; a trailing "00:00:00" end means 24:00. */
function toMinutes(value, isEnd) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m) return null;
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (isEnd && mins === 0) mins = 24 * 60;
  return mins;
}

function groupParts(label) {
  const [group, subgroup = ''] = String(label).split('.');
  return { group, subgroup };
}

function compareLabels(a, b) {
  const [ag, asg = '0'] = a.split('.');
  const [bg, bsg = '0'] = b.split('.');
  return Number(ag) - Number(bg) || Number(asg) - Number(bsg);
}

/**
 * Raw is stored in the schema's `{preset, fact}` container: queues + slots live
 * under `preset`, the active per-day schedules under `fact`.
 *
 * @param {{preset: {queues: Array, slots: Array}, fact: {active: Array}}} raw
 * @returns {{groups: string[], schedules: Object.<string, import('../../core/schema.js').GroupSchedule>}}
 */
export function normalizeMykolaiv(raw) {
  const preset = (raw && raw.preset) || {};
  const fact = (raw && raw.fact) || {};
  const queueById = new Map((preset.queues || []).map((q) => [q.id, q.name]));
  const slotById = new Map((preset.slots || []).map((s) => [s.id, s]));

  /** @type {Map<string, Array>} label -> segments */
  const byLabel = new Map();

  for (const sched of fact.active || []) {
    if (!sched || !Array.isArray(sched.series) || !sched.from) continue;
    const day = kyivDateParts(new Date(sched.from));

    for (const item of sched.series) {
      if (!item) continue;
      const mapped = typeToInterval(item.type);
      if (!mapped) continue;
      const label = queueById.get(item.outage_queue_id);
      const slot = slotById.get(item.time_series_id);
      if (!label || !slot) continue;
      const from = toMinutes(slot.start, false);
      const to = toMinutes(slot.end, true);
      if (from === null || to === null || to <= from) continue;

      const segs = byLabel.get(label) || [];
      segs.push({
        startMs: kyivWallToInstant(day.year, day.month, day.day, from).getTime(),
        endMs: kyivWallToInstant(day.year, day.month, day.day, to).getTime(),
        kind: mapped.kind,
        type: mapped.type,
        origin: 'fact',
      });
      byLabel.set(label, segs);
    }
  }

  const groups = [...byLabel.keys()].sort(compareLabels);
  const schedules = {};
  for (const label of groups) {
    const { group, subgroup } = groupParts(label);
    const intervals = mergeIntervals(byLabel.get(label)).map((s) => ({
      start: toKyivIso(new Date(s.startMs)),
      end: toKyivIso(new Date(s.endMs)),
      kind: s.kind,
      type: s.type,
      origin: s.origin,
    }));
    schedules[label] = { group, subgroup, name: `Черга ${label}`, intervals };
  }

  return { groups, schedules };
}
