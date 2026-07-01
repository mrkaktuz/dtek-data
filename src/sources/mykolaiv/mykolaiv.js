/**
 * Миколаївобленерго adapter.
 *
 * Unlike DTEK/ztoe this is a clean public JSON API (off.energy.mk.ua) with no
 * anti-bot challenge, so it needs no browser — we fetch three endpoints over
 * plain HTTPS and join them in {@link normalizeMykolaiv}. The `page` argument is
 * ignored (the pipeline still hands one over for the browser-based sources).
 */

import { CollectError, STATUS } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { kyivDateParts } from '../../core/time.js';
import { normalizeMykolaiv } from './parse.js';

const BASE_URL = 'https://off.energy.mk.ua';
const REQUEST_TIMEOUT_MS = Number(process.env.MYKOLAIV_TIMEOUT_MS || 20000);

async function getJson(path) {
  const res = await fetch(BASE_URL + path, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (dtek-data collector)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new CollectError(STATUS.NO_DATA, `Mykolaiv API ${path} -> HTTP ${res.status}`);
  return res.json();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Latest `updated_at` across the active series, as a Kyiv "DD.MM.YYYY HH:mm" label. */
function sourceUpdatedAt(active) {
  let max = 0;
  for (const sched of active || []) {
    for (const item of (sched && sched.series) || []) {
      const t = Date.parse(item && item.updated_at);
      if (Number.isFinite(t) && t > max) max = t;
    }
  }
  if (!max) return null;
  const d = kyivDateParts(new Date(max));
  // Reuse kyivDateParts for the date; derive HH:mm via a Kyiv formatter.
  const hm = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(max));
  return `${pad(d.day)}.${pad(d.month)}.${d.year} ${hm}`;
}

async function fetchSnapshot() {
  const [queues, slots, active] = await Promise.all([
    getJson('/api/outage-queue/by-type/3'),
    getJson('/api/schedule/time-series'),
    getJson('/api/v2/schedule/active'),
  ]);

  if (!Array.isArray(queues) || queues.length === 0) {
    throw new CollectError(STATUS.NO_DATA, 'Mykolaiv API returned no queues');
  }
  if (!Array.isArray(active)) {
    throw new CollectError(STATUS.NO_DATA, 'Mykolaiv API returned no active schedule');
  }

  log.info('mykolaiv fetched', { queues: queues.length, slots: slots.length, schedules: active.length });
  // Shape into the schema's {preset, fact} container so the raw snapshot is preserved.
  return { preset: { queues, slots }, fact: { active }, sourceUpdatedAt: sourceUpdatedAt(active) };
}

/** @type {import('../../core/schema.js').SourceAdapter} */
const adapter = {
  id: 'mykolaiv',
  displayName: 'Миколаївобленерго',
  region: 'Миколаївська область',
  url: `${BASE_URL}/`,
  fetch: () => fetchSnapshot(),
  parse: (raw) => normalizeMykolaiv(raw),
};

export default adapter;
export const __test__ = { sourceUpdatedAt };
