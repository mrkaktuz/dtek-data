/**
 * Orchestration: for each source — fetch (with retries) → parse → build a
 * document → write it. One failing source never aborts the others; it just
 * gets a failure document that preserves its last good data.
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
} from './publish.js';
import { STATUS } from './schema.js';
import { log } from './logger.js';

async function readStorageState(storageStatePath) {
  if (!storageStatePath) return undefined;
  try {
    return JSON.parse(await readFile(storageStatePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * @param {Object} options
 * @param {import('./schema.js').SourceAdapter[]} options.sources
 * @param {string} options.outDir
 * @param {number} [options.attempts]
 * @param {string|null} [options.storageStatePath]
 */
export async function runPipeline({ sources, outDir, attempts = 3, storageStatePath = null }) {
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
    for (const adapter of sources) {
      const previous = await loadDocument(outDir, adapter.id);
      const candidate = buildFailureDocument(adapter, previous, STATUS.PARSE_ERROR, err && err.message);
      docs.push(await persistDocument(outDir, candidate, previous));
    }
    await persistIndex(outDir, docs);
    return { docs, allOk: false };
  }

  const docs = [];
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
      docs.push(await persistDocument(outDir, candidate, previous));
    }
    if (storageStatePath) await session.saveState(storageStatePath).catch(() => {});
  } finally {
    await session.close();
  }

  await persistIndex(outDir, docs);
  return { docs, allOk: docs.every((doc) => doc.status.ok) };
}

/** Save a document, keeping the previous one when nothing but the timestamp changed. */
async function persistDocument(outDir, candidate, previous) {
  const doc = reconcileDocument(candidate, previous);
  await saveDocument(outDir, doc);
  return doc;
}

/** Write the index only when the source set/state actually changed. */
async function persistIndex(outDir, docs) {
  const previous = await loadIndex(outDir);
  const index = reconcileIndex(buildIndex(docs), previous);
  await writeIndex(outDir, index);
}
