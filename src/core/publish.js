/**
 * Build and persist the published documents.
 *
 * On a failed run we keep the last good `groups`/`schedules`/`raw` and only
 * refresh `status` + `updatedAt`, so consumers see stale-but-usable data
 * instead of an empty file.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, STATUS } from './schema.js';
import { toKyivIso } from './time.js';

// Matches ANSI SGR sequences (ESC [ … m); ESC is built via char code to keep
// the source free of literal control characters.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Strip ANSI codes and collapse whitespace so messages stay JSON-clean. */
function cleanMessage(message) {
  if (!message) return null;
  return String(message).replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
}

function sourceMeta(adapter) {
  return {
    id: adapter.id,
    name: adapter.displayName,
    region: adapter.region,
    url: adapter.url,
  };
}

/** Stable sha256 over the data-bearing parts of a document. */
export function computeHash({ groups, schedules, raw }) {
  const json = JSON.stringify({ groups, schedules, raw });
  return 'sha256:' + createHash('sha256').update(json).digest('hex');
}

/** Read a previously published JSON file, or null if none/unreadable. */
async function loadJson(outDir, file) {
  try {
    return JSON.parse(await readFile(path.join(outDir, file), 'utf8'));
  } catch {
    return null;
  }
}

/** Read a previously published document, or null if none/unreadable. */
export function loadDocument(outDir, id) {
  return loadJson(outDir, `${id}.json`);
}

/** Read the previously published index, or null. */
export function loadIndex(outDir) {
  return loadJson(outDir, 'index.json');
}

/** How many run-log entries to retain (JSON Lines, newest at the end). */
export const MAX_LOG_ENTRIES = 1000;

/** Append one run entry to log.jsonl, trimming to the most recent entries. */
export async function appendRunLog(outDir, entry, maxEntries = MAX_LOG_ENTRIES) {
  const file = path.join(outDir, 'log.jsonl');
  let lines = [];
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(entry));
  if (lines.length > maxEntries) lines = lines.slice(lines.length - maxEntries);
  await mkdir(outDir, { recursive: true });
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/** Deep-equal two objects after dropping volatile keys. */
function equalIgnoring(a, b, ignoreKeys) {
  const strip = (obj) => {
    const clone = JSON.parse(JSON.stringify(obj));
    for (const key of ignoreKeys) delete clone[key];
    return JSON.stringify(clone);
  };
  return Boolean(a) && Boolean(b) && strip(a) === strip(b);
}

/**
 * Avoid churn: if the new document matches the previous one apart from its
 * timestamp, keep the previous one so the file (and git) stays unchanged.
 */
export function reconcileDocument(candidate, previous) {
  return equalIgnoring(candidate, previous, ['updatedAt']) ? previous : candidate;
}

/** Same idea for the index, ignoring its generation timestamp. */
export function reconcileIndex(candidate, previous) {
  return equalIgnoring(candidate, previous, ['generatedAt']) ? previous : candidate;
}

/** Document for a successful collection. */
export function buildSuccessDocument(adapter, parsed, raw, now = new Date()) {
  const groups = parsed.groups;
  const schedules = parsed.schedules;
  const rawSnapshot = { preset: raw.preset ?? null, fact: raw.fact ?? null };
  return {
    schemaVersion: SCHEMA_VERSION,
    source: sourceMeta(adapter),
    updatedAt: toKyivIso(now),
    status: {
      ok: true,
      code: STATUS.OK,
      message: null,
      contentHash: computeHash({ groups, schedules, raw: rawSnapshot }),
      sourceUpdatedAt: raw.sourceUpdatedAt ?? null,
    },
    groups,
    schedules,
    raw: rawSnapshot,
  };
}

/** Document for a failed collection — reuses previous data when available. */
export function buildFailureDocument(adapter, previous, code, message, now = new Date()) {
  const groups = previous?.groups ?? [];
  const schedules = previous?.schedules ?? {};
  const raw = previous?.raw ?? { preset: null, fact: null };
  return {
    schemaVersion: SCHEMA_VERSION,
    source: sourceMeta(adapter),
    updatedAt: toKyivIso(now),
    status: {
      ok: false,
      code,
      message: cleanMessage(message),
      contentHash: previous?.status?.contentHash ?? null,
      sourceUpdatedAt: previous?.status?.sourceUpdatedAt ?? null,
    },
    groups,
    schedules,
    raw,
  };
}

const BADGE_COLORS = {
  ok: 'brightgreen',
  waf_blocked: 'orange',
  timeout: 'orange',
  no_data: 'red',
  parse_error: 'red',
};

/**
 * Build a Shields.io "endpoint" badge object for a source. Content is kept
 * stable (no timestamps) so the badge file only changes on a real status/size
 * change, not every run.
 */
export function buildBadge(doc) {
  const code = doc.status.code;
  return {
    schemaVersion: 1,
    label: doc.source.id,
    message: doc.status.ok ? `ok · ${doc.groups.length} груп` : code,
    color: BADGE_COLORS[code] || 'lightgrey',
  };
}

export async function writeBadge(outDir, doc) {
  const dir = path.join(outDir, 'badges');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${doc.source.id}.json`);
  await writeFile(file, JSON.stringify(buildBadge(doc)) + '\n', 'utf8');
  return file;
}

/** Overall "last updated" badge: run time + how many sources are ok. */
export function buildOverallBadge({ stamp, okCount, total }) {
  const allOk = total > 0 && okCount === total;
  return {
    schemaVersion: 1,
    label: 'оновлено',
    message: total ? `${stamp} · ${okCount}/${total} ok` : stamp,
    color: allOk ? 'brightgreen' : okCount > 0 ? 'orange' : 'red',
  };
}

export async function writeOverallBadge(outDir, badge) {
  const dir = path.join(outDir, 'badges');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'status.json');
  await writeFile(file, JSON.stringify(badge) + '\n', 'utf8');
  return file;
}

export async function saveDocument(outDir, doc) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${doc.source.id}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

/** Build the cross-source summary index (pure). */
export function buildIndex(docs, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: toKyivIso(now),
    sources: docs.map((doc) => ({
      id: doc.source.id,
      name: doc.source.name,
      region: doc.source.region,
      updatedAt: doc.updatedAt,
      status: doc.status.code,
      groups: doc.groups,
      file: `${doc.source.id}.json`,
    })),
  };
}

export async function writeIndex(outDir, index) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'index.json');
  await writeFile(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return file;
}
