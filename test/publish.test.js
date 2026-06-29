import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileDocument, reconcileIndex, buildBadge } from '../src/core/publish.js';

const baseDoc = () => ({
  schemaVersion: '1.0',
  source: { id: 'x' },
  updatedAt: '2026-06-29T10:00:00+03:00',
  status: { ok: true, code: 'ok', contentHash: 'sha256:aaa' },
  groups: ['1.1'],
  schedules: { '1.1': { intervals: [] } },
  raw: { preset: {}, fact: {} },
});

test('reconcileDocument keeps previous when only the timestamp differs', () => {
  const previous = baseDoc();
  const candidate = { ...baseDoc(), updatedAt: '2026-06-29T10:05:00+03:00' };
  assert.equal(reconcileDocument(candidate, previous), previous);
});

test('reconcileDocument takes candidate when content changes', () => {
  const previous = baseDoc();
  const candidate = baseDoc();
  candidate.updatedAt = '2026-06-29T10:05:00+03:00';
  candidate.schedules['1.1'].intervals.push({ start: 'a', end: 'b', kind: 'off' });
  assert.equal(reconcileDocument(candidate, previous), candidate);
});

test('reconcileDocument takes candidate when status changes (ok -> failure)', () => {
  const previous = baseDoc();
  const candidate = { ...baseDoc(), updatedAt: '2026-06-29T10:05:00+03:00', status: { ok: false, code: 'waf_blocked' } };
  assert.equal(reconcileDocument(candidate, previous), candidate);
});

test('reconcileDocument takes candidate when there is no previous', () => {
  const candidate = baseDoc();
  assert.equal(reconcileDocument(candidate, null), candidate);
});

test('buildBadge is green with group count when ok, red/code when failed', () => {
  const ok = buildBadge({ source: { id: 'dtek-krem' }, status: { ok: true, code: 'ok' }, groups: ['1.1', '1.2'] });
  assert.equal(ok.schemaVersion, 1);
  assert.equal(ok.color, 'brightgreen');
  assert.match(ok.message, /^ok · 2 груп$/);

  const bad = buildBadge({ source: { id: 'dtek-krem' }, status: { ok: false, code: 'waf_blocked' }, groups: [] });
  assert.equal(bad.color, 'orange');
  assert.equal(bad.message, 'waf_blocked');
});

test('reconcileIndex ignores generatedAt', () => {
  const previous = { schemaVersion: '1.0', generatedAt: 't1', sources: [{ id: 'x', status: 'ok' }] };
  const same = { ...previous, generatedAt: 't2' };
  assert.equal(reconcileIndex(same, previous), previous);
  const changed = { ...previous, generatedAt: 't2', sources: [{ id: 'x', status: 'waf_blocked' }] };
  assert.equal(reconcileIndex(changed, previous), changed);
});
