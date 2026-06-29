/**
 * Domain types and shared constants for the outage-schedule collector.
 *
 * The published documents follow a stable, normalized shape that is
 * independent of any single upstream provider. Adapters translate a
 * provider-specific payload into these structures.
 */

/** Bumped only on breaking changes to the published JSON shape. */
export const SCHEMA_VERSION = '1.0';

/** Result codes recorded in {@link CollectStatus.code}. */
export const STATUS = Object.freeze({
  OK: 'ok',
  WAF_BLOCKED: 'waf_blocked',
  TIMEOUT: 'timeout',
  PARSE_ERROR: 'parse_error',
  NO_DATA: 'no_data',
});

/** Whether power is cut for sure or only potentially. */
export const KIND = Object.freeze({
  OFF: 'off',
  POSSIBLE: 'possible',
});

/** Classification of an outage interval. */
export const OUTAGE_TYPE = Object.freeze({
  PLANNED: 'planned',
  POSSIBLE: 'possible',
  EMERGENCY: 'emergency',
  STABILIZATION: 'stabilization',
});

/**
 * @typedef {Object} OutageInterval
 * @property {string} start  ISO 8601 with offset, Europe/Kyiv.
 * @property {string} end    ISO 8601 with offset, Europe/Kyiv.
 * @property {'off'|'possible'} kind
 * @property {'planned'|'possible'|'emergency'|'stabilization'} type
 * @property {'preset'|'fact'} origin  Which upstream branch produced the interval.
 */

/**
 * @typedef {Object} GroupSchedule
 * @property {string} group     Primary queue, e.g. "1".
 * @property {string} subgroup  Sub-queue, e.g. "1" (queue 1.1).
 * @property {string|null} name Human label from the provider, e.g. "Черга 1.1".
 * @property {OutageInterval[]} intervals  Flattened, dated, time-ordered.
 */

/**
 * @typedef {Object} CollectStatus
 * @property {boolean} ok
 * @property {string} code     One of {@link STATUS}.
 * @property {string|null} message
 * @property {string|null} contentHash  sha256 of the normalized payload.
 * @property {string|null} sourceUpdatedAt  Upstream "last updated" label, if any.
 */

/**
 * @typedef {Object} SourceMeta
 * @property {string} id
 * @property {string} name
 * @property {string} region
 * @property {string} url
 */

/**
 * @typedef {Object} ScheduleDocument
 * @property {string} schemaVersion
 * @property {SourceMeta} source
 * @property {string} updatedAt  ISO 8601, when this source's published data last changed.
 * @property {CollectStatus} status
 * @property {string[]} groups   All discovered "group.subgroup" labels, sorted.
 * @property {Object.<string, GroupSchedule>} schedules  Keyed by "group.subgroup".
 * @property {{preset: unknown, fact: unknown}} raw  Untouched upstream snapshot.
 */

/**
 * @typedef {Object} RawSnapshot
 * @property {unknown} preset
 * @property {unknown} fact
 * @property {string|null} sourceUpdatedAt
 */

/**
 * @typedef {Object} SourceAdapter
 * @property {string} id
 * @property {string} displayName
 * @property {string} region
 * @property {string} url
 * @property {(page: import('playwright').Page) => Promise<RawSnapshot>} fetch
 * @property {(raw: RawSnapshot) => {groups: string[], schedules: Object.<string, GroupSchedule>}} parse
 */

export {};
