# AGENTS.md — context for future work on dtek-data

Operational context and hard-won facts for anyone (human or agent) continuing
this project. Read this before changing the collector. User-facing docs are in
`README.md` (Ukrainian).

## What this is

A universal collector of power-outage schedules. A GitHub Actions workflow runs
every ~5 minutes, renders provider sites with a headless browser, normalizes the
data into a stable JSON shape, and publishes it to the orphan **`data`** branch.
A separate Home Assistant integration (different repo, not here) will consume the
published JSON. Keep the parser provider-agnostic: shared core + one adapter per
provider.

## Repository layout

```
src/
  core/
    schema.js     SCHEMA_VERSION, STATUS/KIND/OUTAGE_TYPE consts, JSDoc typedefs
    time.js       Europe/Kyiv <-> instant (DST-aware), ISO 8601, mergeIntervals
    browser.js    Playwright session, light stealth, retry/backoff (CollectError)
    errors.js     CollectError (kept import-light so adapters don't load Playwright)
    pipeline.js   per-source orchestrate -> persist -> index -> run log -> notify
    publish.js    document/index builders, hashing, reconcile (no-churn), run log, badges
    notify.js     optional Telegram notifications (env-gated, best-effort)
    logger.js     stderr structured logs (LOG_LEVEL)
  sources/
    registry.js   list of adapters — add new sources here
    dtek/
      adapter.js     shared DTEK fetch (DisconSchedule) + HTML fallback
      normalize.js   DisconSchedule -> normalized schedule
      dtek-krem.js   config: Kyiv region
      dtek-kem.js    config: Kyiv city
  index.js        CLI entry (parse args -> runPipeline)
test/             node:test unit tests + fixtures (no browser needed)
.github/workflows/collect.yml   scheduled run -> publishes to data branch
data/ (orphan branch only)      <source>.json, index.json, log.jsonl, badges/<source>.json
```

Published data lives ONLY on the `data` branch, never on `main`. `main`'s
`.gitignore` excludes `/data/`.

## DTEK source — confirmed facts

Both `dtek-krem` and `dtek-kem` are identical in structure; only the URL/region
differ, so they share `sources/dtek/adapter.js`.

- **WAF: Imperva Incapsula.** A plain HTTP GET returns a ~212-byte stub with
  `<script src="/_Incapsula_Resource?...">` and sets `visid_incap_*` /
  `incap_ses_*` cookies. Real data only appears after the browser runs the JS
  challenge → a real browser (Playwright) is mandatory; `fetch`/`curl` cannot work.
- **Data lives in `window.DisconSchedule`** with two branches:
  - `preset.data[groupKey][dow][hour]` — weekly template.
    `dow` = ISO weekday `"1".."7"` (1=Mon), `hour` = `"1".."24"`.
  - `fact.data[unixSeconds][groupKey][hour]` — actual outages for specific dates.
    The timestamp key is **unix seconds**; `fact.today` and `fact.update` exist too.
  - `groupKey` is prefixed `GPV`, e.g. `"GPV1.1"` (we strip to label `"1.1"`).
  - `preset.sch_names[groupKey]` → human label, e.g. `"Черга 1.1"`.
  - `preset.time_zone[hour]` confirms hour `"1"` = 00:00–01:00 … `"24"` = 23:00–24:00.
  - `fact.update` (and `preset.updateFact`) = `"DD.MM.YYYY HH:mm"` → `sourceUpdatedAt`.
- **Hour codes** (`preset.time_type`): `yes` (power on, no interval), `no`
  (full-hour outage), `maybe` (full-hour possible), `first`/`second` (outage in
  1st/2nd half-hour), `mfirst`/`msecond` (possible in 1st/2nd half-hour).
- There is **no emergency/stabilization marker** in this payload — everything maps
  to `planned` (for off) / `possible`. The `emergency`/`stabilization` types exist
  in the schema for the future; `resolveFactType` reads a type field if one ever
  appears. The raw snapshot is preserved so nothing is lost if the shape changes.
- Counts seen live: dtek-krem ~12 queues (1.1–6.2), dtek-kem ~60–66 queues.
- An unused AJAX endpoint `/ua/ajax` (CSRF) exists for address lookup — not needed,
  we read all groups straight from `DisconSchedule`.

### Fetch behavior (adapter.js)

1. `goto(url, domcontentloaded)`, dismiss a `[data-micromodal-close]` modal if present.
2. `waitForFunction` until `DisconSchedule.preset.data` is non-empty
   (`DTEK_DATA_TIMEOUT_MS`, default 180000).
3. In CI, Incapsula reloads the page and destroys the wait context, so the wait
   often throws quickly → we **fall back to parsing `DisconSchedule.preset/.fact`
   straight from the page HTML** via brace matching (`sliceBalanced`). This path is
   the common success path in CI; it works because the data is inline in the HTML.
   If the HTML is the short Incapsula stub → `CollectError(WAF_BLOCKED)`.

## Output schema (normalized)

`data/<source>.json`: `{ schemaVersion, source{id,name,region,url}, updatedAt,
status{ok,code,message,contentHash,sourceUpdatedAt}, groups[], schedules{label ->
{group,subgroup,name,intervals[]}}, raw{preset,fact} }`.
Interval: `{ start, end, kind: off|possible, type: planned|possible|emergency|
stabilization, origin: preset|fact }`, times ISO 8601 with Kyiv offset.

Normalization (`normalize.js`): expand `preset` over a rolling `HORIZON_DAYS`
(7) of concrete dates; `fact` overrides `preset` for the dates it covers; merge
adjacent same kind+type intervals; `yes`/unknown produce no interval.

## Publishing model

- On failure, keep previous `groups/schedules/raw`; update only `status` +
  `updatedAt` (`buildFailureDocument`). Never publish emptiness.
- **No-churn**: `reconcileDocument`/`reconcileIndex` keep the previous file
  byte-identical when only `updatedAt`/`generatedAt` would differ, so per-source
  files (and `index.json`) only change on real change. `updatedAt` = last real change.
- **Run log**: `appendRunLog` writes one line per run to `data/log.jsonl`
  (capped `MAX_LOG_ENTRIES`=1000). Because it changes every run, the data branch
  gets one commit per run (a heartbeat). If commit volume becomes a problem,
  switch to logging only `changed`/non-ok runs.
- Content hash (`computeHash`) is over `groups+schedules+raw` (excludes timestamps/status).
- **Badges**: `writeBadge` emits a Shields.io endpoint JSON per source to
  `data/badges/<id>.json` (color by status, message = group count); content is
  timestamp-free so those change only on real status/size changes.
  `writeOverallBadge` emits `data/badges/status.json` ("оновлено" + run time +
  ok ratio) every run.

## CI / Actions (collect.yml)

- Triggers: `schedule */5`, `workflow_dispatch`, and `push` to `main` (dev convenience,
  paths-filtered to src/workflow/package files).
- Steps: checkout → setup-node → `npm ci` → `npx playwright install --with-deps
  chromium` → restore browser-state cache → add `data` worktree (orphan on first
  run) → `node src/index.js --out data-branch` → commit & push to `data` if `git`
  sees a diff.
- Publishes with the built-in `GITHUB_TOKEN` (`permissions: contents: write`).
  **No PAT needed** to push to `data` in this repo.
- `schedule`/`workflow_dispatch` only register from the **default branch**
  (now `main`). The cron is best-effort (can be delayed/skipped).
- **Gotcha:** GitHub (re)reads the cron only when `collect.yml` *changes on the
  default branch*. Switching the default branch in Settings does NOT re-register
  it — after such a switch, push a commit that touches `collect.yml` to main to
  activate the schedule. The `push` trigger is the reliable fallback meanwhile.

## Notifications (notify.js)

Optional Telegram alerts, env-gated and best-effort (never throw). `buildNotifications`
(pure) maps per-source events to messages: data change on a healthy source → silent;
ok→fail and fail→ok transitions → loud; otherwise nothing (no spam while broken).
A failure is announced only on the ok→fail edge (`prevOk !== false`); while the
source stays broken across consecutive runs it is silent, and recovery (first
fail→ok) is always announced — `prevOk` is the previously *published* doc, which
holds `ok:false` for the whole outage. Silent update messages carry a short diff
from `summarizeChange(previous, doc)` (changed/added/removed queues + net off-hours).
Pipeline computes events via `eventOf(doc, previous, changed)` (prevOk from the
previously published doc). Credentials: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
optional `TELEGRAM_THREAD_ID` (forum-group topic → `message_thread_id`). GitHub
secrets; never committed. Absent creds ⇒ no-op.

## Schedule / triggering

The only trigger is `workflow_dispatch`. GitHub cron and the push trigger were
removed (cron is throttled for low-traffic repos; GitHub guarantees no interval).
Runs are started by an **external scheduler** — the owner runs a systemd timer on
their Ubuntu box that POSTs to
`/repos/<owner>/dtek-data/actions/workflows/collect.yml/dispatches`
(`Authorization: Bearer <PAT>`, fine-grained, Actions: read+write; body
`{"ref":"main"}` → 204). No token-less trigger URL exists.

Overlap protection: workflow has `concurrency: collect` (no parallel runs, at
most one queued), and the server's dispatch script skips POST when a run is
already queued/in_progress (GET .../runs), so the effective interval is never
shorter than one collection (~3–4 min) regardless of the timer period.

Note for CI verification from here: with no push trigger, commits to main no
longer auto-run the workflow; the server's timer drives runs, or trigger one via
the workflow_dispatch API. (A PAT self-dispatch chain was tried and removed as
too fragile.) Reminder: workflow_dispatch must exist on the default branch.

## Environment knobs

`LOG_LEVEL` (debug|info|warn|error), `STORAGE_STATE_PATH` (persist cookies between
runs), `DTEK_DATA_TIMEOUT_MS` (default 180000), `DTEK_NAV_TIMEOUT_MS` (45000),
`CHROMIUM_EXECUTABLE` (override Chromium path — used for local sandboxes).
Secrets (CI): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_THREAD_ID`.
External scheduler holds its own PAT (not a repo secret).

## Run & verify

```bash
npm ci && npx playwright install --with-deps chromium
node src/index.js                 # all sources -> ./data
node src/index.js --source dtek-krem --out ./out
npm test                          # 20 unit tests, no browser required
```

Live verification is via Actions: trigger a run (push to main or workflow_dispatch),
then read job logs and inspect the `data` branch (`git show origin/data:dtek-krem.json`).

## Adding a source

1. New adapter exposing `{ id, displayName, region, url, fetch(page), parse(raw) }`
   (see `sources/dtek/adapter.js`; for another DTEK region just call
   `createDtekAdapter({...})` like `dtek-krem.js`).
2. Register it in `sources/registry.js`. Pipeline/publish/CI need no changes.

## Sandbox gotchas (this dev environment)

- Headless Chromium cannot egress through the agent proxy here (ERR_CONNECTION_CLOSED
  on any HTTPS), so live fetches must be verified in GitHub Actions, not locally.
  `curl` works through the proxy (use it to inspect the Incapsula stub).
- The npm `playwright` may want a newer Chromium revision than the preinstalled one;
  set `CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` to
  launch the bundled browser locally.
- The GitHub MCP integration token can read Actions but **cannot** dispatch
  workflows (403) or change repo settings; that's why `push` triggers runs and the
  default-branch switch was done by the user.
- `import { chromium } from 'playwright'` is ESM-incompatible with the global CJS
  build; in throwaway scripts use `import pkg from '.../playwright/index.js'`.

## Conventions

Plain JS, ESM (`"type":"module"`), Node ≥20, no TypeScript. No external deps beyond
Playwright; tests use the built-in `node:test`. Keep the solution original — do not
copy naming or code from third-party DTEK scrapers.

## Workflow

- **Branch:** work directly on `main` for this repo. No feature branches —
  commit and push changes straight to `main`.
- **Language:** always communicate with the user in Ukrainian (українською).
