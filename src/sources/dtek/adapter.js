/**
 * Shared DTEK adapter. All DTEK regional sites expose the same
 * `window.DisconSchedule` global, so a single fetch+parse implementation is
 * parameterized per region by {@link createDtekAdapter}.
 */

import { CollectError, STATUS } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { normalize } from './normalize.js';

const NAV_TIMEOUT_MS = Number(process.env.DTEK_NAV_TIMEOUT_MS || 45000);
const DATA_TIMEOUT_MS = Number(process.env.DTEK_DATA_TIMEOUT_MS || 180000);

/** Read a `DisconSchedule.<key> = {…}` literal from raw HTML via brace matching. */
function sliceBalanced(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return null;
  let i = html.indexOf('=', markerIdx);
  if (i < 0) return null;
  i += 1;
  while (i < html.length && /\s/.test(html[i])) i += 1;
  const open = html[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let j = i; j < html.length; j += 1) {
    const ch = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return html.slice(i, j + 1);
    }
  }
  return null;
}

/** Fallback extraction straight from the served HTML if the global is absent. */
function extractFromHtml(html) {
  const presetText = sliceBalanced(html, 'DisconSchedule.preset');
  if (!presetText) return null;
  const factText = sliceBalanced(html, 'DisconSchedule.fact');
  try {
    const preset = JSON.parse(presetText);
    const fact = factText ? JSON.parse(factText) : null;
    return {
      preset,
      fact,
      sourceUpdatedAt: (fact && fact.update) || (preset && preset.updateFact) || null,
    };
  } catch {
    return null;
  }
}

async function readUpdatedLabel(page) {
  return page
    .evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const match = text.match(/оновлен[оа][^\d]*(\d{2}\.\d{2}\.\d{4}[^\d]*\d{2}:\d{2})/i);
      return match ? match[1].replace(/\s+/g, ' ').trim() : null;
    })
    .catch(() => null);
}

/** Dismiss the promo/info modal that sometimes covers the page. */
async function dismissModal(page) {
  await page.locator('[data-micromodal-close]').first().click({ timeout: 1500 }).catch(() => {});
}

/** Read the live DisconSchedule snapshot, or null if preset.data is still empty. */
async function readSnapshot(page) {
  const raw = await page
    .evaluate(() => {
      const ds = window.DisconSchedule || {};
      return { preset: ds.preset ?? null, fact: ds.fact ?? null };
    })
    .catch(() => null);
  if (!raw || !raw.preset || !raw.preset.data || Object.keys(raw.preset.data).length === 0) return null;
  raw.sourceUpdatedAt =
    (raw.fact && raw.fact.update) ||
    (raw.preset && raw.preset.updateFact) ||
    (await readUpdatedLabel(page));
  return raw;
}

/**
 * Navigate and clear the Incapsula challenge, then return the raw snapshot.
 *
 * Incapsula serves a tiny stub whose script sets `visid_incap_*`/`incap_ses_*`
 * cookies and reloads; under load it may also show a "please wait" page. Rather
 * than a single wait that dies the moment the page reloads, we poll patiently:
 * if we are still on a challenge/stub page we let its script run and reload with
 * the fresh cookies; if the real page is up we wait for its JS to populate
 * `DisconSchedule`. This keeps trying for the whole `DATA_TIMEOUT_MS` budget.
 */
async function fetchSnapshot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await dismissModal(page);

  // The tiny Incapsula challenge stub is ~1 KB; the real page is tens of KB.
  // (The real page ALSO embeds an `_Incapsula_Resource` telemetry script, so
  // that marker alone is NOT a reliable "still challenged" signal — only size is.)
  const looksLikeStub = (html) => !html || html.length < 2500;

  const deadline = Date.now() + DATA_TIMEOUT_MS;
  let sawChallenge = false;
  let reachedRealPage = false;
  let reloads = 0;

  while (Date.now() < deadline) {
    // 1) Fast path: the app JS populated the live global.
    const raw = await readSnapshot(page).catch(() => null);
    if (raw) {
      if (sawChallenge) log.info('Incapsula challenge cleared', { url, reloads });
      return raw;
    }

    // 2) The cleared page embeds preset/fact inline — parse straight from HTML
    //    the moment the real page is served, without waiting for its JS.
    const html = await page.content().catch(() => '');
    const stub = looksLikeStub(html);
    if (!stub) {
      reachedRealPage = true;
      const fallback = extractFromHtml(html);
      if (fallback) {
        if (sawChallenge) log.info('Incapsula challenge cleared', { url, reloads });
        return fallback;
      }
    }

    // 3) Still on the stub → let its script set cookies, then reload so the
    //    follow-up request carries them; on a real-but-not-ready page just wait.
    sawChallenge = sawChallenge || stub;
    await page.waitForTimeout(stub ? 3000 : 1500);
    if (stub) {
      reloads += 1;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await dismissModal(page);
    }
  }

  // Budget exhausted — one last parse, otherwise classify the block.
  const html = await page.content().catch(() => '');
  const fallback = extractFromHtml(html);
  if (fallback) {
    log.info('used HTML fallback extraction', { url });
    return fallback;
  }
  if (!reachedRealPage && looksLikeStub(html)) {
    throw new CollectError(STATUS.WAF_BLOCKED, 'Incapsula challenge did not clear');
  }
  throw new CollectError(STATUS.TIMEOUT, 'DisconSchedule did not populate in time');
}

/**
 * @param {{id: string, displayName: string, region: string, url: string}} config
 * @returns {import('../../core/schema.js').SourceAdapter}
 */
export function createDtekAdapter(config) {
  return {
    id: config.id,
    displayName: config.displayName,
    region: config.region,
    url: config.url,
    fetch: (page) => fetchSnapshot(page, config.url),
    parse: (raw) => normalize(raw),
  };
}

export const __test__ = { sliceBalanced, extractFromHtml };
