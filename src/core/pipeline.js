/**
 * Orchestration: for each source — fetch (with retries) → parse → build a
 * document → write it. One failing source never aborts the others; it just
 * gets a failure document that preserves its last good data. Every run also
 * appends an entry to the run log so the data branch carries its own history.
 */

import { readFile } from 'node:fs/promises';
import { createSession, fetchWithRetry, CollectError } from './browser.js';
import {
  loadDocument,
  loadIndex,
  buildSuccessDocument,
  buildFailureDocument,
  reconcileDocument,
  reconcileIndex,
  buildIndex,
  saveDocument,
  writeIndex,
  writeBadge,
  buildOverallBadge,
  writeOverallBadge,
  appendRunLog,
} from './publish.js';
import { STATUS } from './schema.js';
import { toKyivIso } from './time.js';
import { log } from './logger.js';

async function readStorageState(storageStatePath) {
  if (!storageStatePath) return undefined;
  try {
    return JSON.parse(await readFile(storageStatePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function summarize(doc, changed) {
  return {
    id: doc.source.id,
    status: doc.status.code,
    ok: doc.status.ok,
    groups: doc.groups.length,
    changed,
    sourceUpdatedAt: doc.status.sourceUpdatedAt,
  };
}

/**
 * @param {Object} options
 * @param {import('./schema.js').SourceAdapter[]} options.sources
 * @param {string} options.outDir
 * @param {number} [options.attempts]
 * @param {string|null} [options.storageStatePath]
 */
export async function runPipeline({ sources, outDir, attempts = 3, storageStatePath = null }) {
  const startedAt = new Date();
  const storageState = await readStorageState(storageStatePath);

  let session;
  try {
    session = await createSession({ storageState });
  } catch (err) {
    // Browser could not even start — still refresh statuses without losing data.
    log.error('browser launch failed; preserving previous data for all sources', {
      message: err && err.message,
    });
    const docs = [];
    const summaries = [];
    for (const adapter of sources) {
      const previous = await loadDocument(outDir, adapter.id);
      const candidate = buildFailureDocument(adapter, previous, STATUS.PARSE_ERROR, err && err.message);
      const { doc, changed } = await persistDocument(outDir, candidate, previous);
      await writeBadge(outDir, doc);
      docs.push(doc);
      summaries.push(summarize(doc, changed));
    }
    await persistIndex(outDir, docs);
    await writeStatusBadge(outDir, startedAt, summaries);
    await writeRunLog(outDir, startedAt, summaries, false);
    return { docs, allOk: false };
  }

  const docs = [];
  const summaries = [];
  try {
    for (const adapter of sources) {
      const previous = await loadDocument(outDir, adapter.id);
      let candidate;
      try {
        const raw = await fetchWithRetry(session.context, adapter, { attempts });
        const parsed = adapter.parse(raw);
        candidate = buildSuccessDocument(adapter, parsed, raw);
        log.info('source collected', { source: adapter.id, groups: parsed.groups.length });
      } catch (err) {
        const code = err instanceof CollectError ? err.code : STATUS.PARSE_ERROR;
        candidate = buildFailureDocument(adapter, previous, code, err && err.message);
        log.error('source failed; kept previous data', {
          source: adapter.id,
          code,
          hadPrevious: Boolean(previous),
        });
      }
      const { doc, changed } = await persistDocument(outDir, candidate, previous);
      await writeBadge(outDir, doc);
      docs.push(doc);
      summaries.push(summarize(doc, changed));
    }
    if (storageStatePath) await session.saveState(storageStatePath).catch(() => {});
  } finally {
    await session.close();
  }

  await persistIndex(outDir, docs);
  const allOk = docs.every((doc) => doc.status.ok);
  await writeStatusBadge(outDir, startedAt, summaries);
  await writeRunLog(outDir, startedAt, summaries, allOk);
  return { docs, allOk };
}

/** Save a document, keeping the previous one when nothing but the timestamp changed. */
async function persistDocument(outDir, candidate, previous) {
  const doc = reconcileDocument(candidate, previous);
  await saveDocument(outDir, doc);
  return { doc, changed: doc !== previous };
}

/** Write the index only when the source set/state actually changed. */
async function persistIndex(outDir, docs) {
  const previous = await loadIndex(outDir);
  const index = reconcileIndex(buildIndex(docs), previous);
  await writeIndex(outDir, index);
}

/** Write the overall "last updated" badge (run time + ok count). */
async function writeStatusBadge(outDir, startedAt, summaries) {
  const stamp = toKyivIso(startedAt).slice(0, 16).replace('T', ' ');
  const okCount = summaries.filter((s) => s.ok).length;
  await writeOverallBadge(outDir, buildOverallBadge({ stamp, okCount, total: summaries.length }));
}

/** Append one entry to the run-history log. */
async function writeRunLog(outDir, startedAt, sources, ok) {
  await appendRunLog(outDir, {
    runAt: toKyivIso(startedAt),
    durationMs: Date.now() - startedAt.getTime(),
    ok,
    changed: sources.some((s) => s.changed),
    sources,
  });
}
