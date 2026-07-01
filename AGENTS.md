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
      normalize.js   DisconSchedule -> normalized schedule (also reused by ztoe)
      dtek-krem.js   config: Kyiv region
      dtek-kem.js    config: Kyiv city
    ztoe/
      parse.js       ztoe coloured HTML table -> DisconSchedule snapshot
      ztoe.js        adapter: Житомиробленерго (reuses dtek/normalize.js)
    mykolaiv/
      parse.js       off.energy.mk.ua JSON (queues+slots+series) -> schedule
      mykolaiv.js    adapter: Миколаївобленерго (plain JSON API, no browser)
  index.js        CLI entry (parse args -> runPipeline)
test/             node:test unit tests + fixtures (no browser needed)
.github/workflows/collect.yml   scheduled run -> publishes to data branch
data/ (orphan branch only)      <source>.json, index.json, log.jsonl, badges/<source>.json
```

Published data lives ONLY on the `data` branch, never on `main`. `main`'s
`.gitignore` excludes `/data/`.

## DTEK source — confirmed facts

All DTEK regions (`dtek-krem` Kyiv region, `dtek-kem` Kyiv city, `dtek-dnem`
Dnipropetrovsk, `dtek-oem` Odesa) are identical in structure; only the URL/region
differ, so they share `sources/dtek/adapter.js` via `createDtekAdapter`. Adding a
DTEK region = one `dtek-<host>.js` config (URL `https://www.dtek-<host>.com.ua/ua/shutdowns`)
+ a line in `registry.js`.

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

### Fetch behavior (adapter.js) — Incapsula bypass

Imperva **fingerprints headless Chromium and refuses to clear its JS challenge**,
so DTEK started returning only the ~965-byte stub (`<script
src="/_Incapsula_Resource?…">`, sets `visid_incap_*`/`incap_ses_*`, reloads).
Two things clear it:

1. **Headful browser under Xvfb.** `createSession` launches `headless:!HEADFUL`;
   CI sets `HEADFUL=1` and runs `xvfb-run -a node src/index.js`. A real on-screen
   Chromium passes the challenge that headless fails. `applyStealth` also masks
   `navigator.webdriver`, plugins/mimeTypes, WebGL vendor, permissions.
2. **Patient poll/reload loop** (replaces the old single `waitForFunction`, which
   died the instant Incapsula reloaded → fast false `WAF_BLOCKED`). Per attempt,
   until `DTEK_DATA_TIMEOUT_MS` (default 180000): read `DisconSchedule.preset.data`;
   if present → return it; if on a stub/challenge page (has `_Incapsula_Resource`
   or `<3000` chars) → wait ~3 s and `reload()` so the fresh cookies fetch the real
   page; else (real page, app JS still loading, e.g. "please wait" under load) →
   just wait. Only when the whole budget is exhausted do we try the inline-HTML
   fallback (`sliceBalanced`/`extractFromHtml`) and then classify `WAF_BLOCKED`.
   `fetchWithRetry` still retries the whole thing 3×.

## ztoe source — confirmed facts (Житомиробленерго)

- URL `https://www.ztoe.com.ua/unhooking-search.php`. **No WAF**, plain
  server-rendered HTML in **windows-1251** (the browser decodes it; a raw
  `fetch`/`curl` needs iconv). A browser is not strictly required but we reuse the
  shared session anyway.
- Per published date there is one `<table>` headed by `<b>DD.MM.YYYY</b>`. Each
  queue 1.1..6.2 is a `<tr>` (`pidcherga_id=N` → `<b>1.1</b>`) with exactly **48
  half-hour cells** styled `background:#RRGGBB`. **Red = off** (detected by RGB:
  `r>200 && g<80 && b<80`, covers `#ff0000`/`#ff3333`), white = on.
- `parse.js` collapses the 48 half-hours into 24 DisconSchedule hour codes
  (`no`/`first`/`second`/`yes`) and emits them under `fact.data[<kyiv-midnight
  unix>][GPV1.1]`, so the **DTEK `normalize.js` is reused verbatim**. No weekly
  `preset` exists; `preset.data` is left empty and `sch_names` are synthesized
  ("Черга 1.1"). Update label parsed from "Дата оновлення інформації - HH:MM
  DD.MM.YYYY" → `sourceUpdatedAt` as "DD.MM.YYYY HH:MM". **Note:** ZTOE bumps this
  label every ~30 min even when the grid is unchanged, so change-detection must
  ignore it (see `reconcileDocument` below) — otherwise every poll spams an
  "оновлено" notification.
- **No-outage state:** when Ukrenergo has not ordered any GPV, ZTOE drops the
  schedule table entirely and shows a "...графіків погодинних відключень... не
  надходило" message. That is a *legitimately empty* schedule (status ok, 0
  groups), NOT a failure — `ztoe.js` detects it and returns an empty snapshot;
  only a genuinely broken page is NO_DATA.
- Modeled on two existing parsers (yaroslav2901/ZTOE_PARSER, IfRiTLove/ztoe-parser);
  code here is original. **Verified end-to-end in CI** both with no outages (ok, 0
  groups) and with a live schedule (ok, 12 groups).

## mykolaiv source — confirmed facts (Миколаївобленерго)

- Clean public JSON API at `https://off.energy.mk.ua`, **no anti-bot / no browser
  needed** (plain `fetch`; the adapter ignores the `page`). Three endpoints joined:
  `/api/outage-queue/by-type/3` (12 sub-queues `id`→`name` "1.1".."6.2"),
  `/api/schedule/time-series` (48 half-hour slots `id`→`start`/`end`; last `end` is
  "00:00:00" = 24:00), `/api/v2/schedule/active` (`[{from,to,series:[{time_series_id,
  outage_queue_id,type}]}]`). `from` is a UTC instant = 00:00 Kyiv of that day.
- `type`: **OFF** → off/planned, **PROBABLY_OFF** → possible; anything else (e.g. ON)
  → no interval. `sourceUpdatedAt` = latest `series[].updated_at` as Kyiv "DD.MM.YYYY HH:mm".
- Raw is stored as `{preset:{queues,slots}, fact:{active}}` so `buildSuccessDocument`
  keeps the snapshot. **Verified end-to-end against the live API** (queues + real
  intervals) — this source, unlike the browser ones, is testable from the sandbox.

## Other regions surveyed (2026-07) — not implemented

Searched for ready sources per region (see also Baskerville42/outage-data-ua, which
covers only DTEK dnipro/kyiv/kyiv-region/odesa — all already here):

- **Chernihiv** — `interruptions.energy.cn.ua` JSON API behind **Cloudflare Turnstile**
  (`{"error":"No captcha"}`); deferred (details below).
- **Lviv (LOE)** — `api.loe.lviv.ua ...type=photo-grafic` publishes schedules as
  **images**; would need OCR. Not feasible cheaply. (adroush/loe_outages)
- **Vinnytsia (VOE)** — `voe.com.ua` is **Cloudflare-challenged** (HTTP 403 + captcha).
- **Cherkasy** — no clean API; schedules live in `cherkasyoblenergo.com` **news posts**
  (DankRank/ckgpv scrapes them) or a Telegram channel (mcfedr/cherkasy-outage-ha).
- **Chernivtsi** — denysdovhan/chernivtsi-outages publishes JSON but is **stale**
  (last data 2023).
- **DTEK Donetsk** (`dtek-dem.com.ua`) — same DisconSchedule platform (HTTP 200), a
  trivial add, but the oblast is largely occupied so schedule coverage is doubtful.

## chernihiv (Чернігівобленерго) — DEFERRED, not implemented

Investigated and intentionally **not added** (owner's call, 2026-06). Notes kept so
the research isn't lost if it's revisited:

- Source is the JSON API `POST https://interruptions.energy.cn.ua/api/info_schedule_part`
  body `{"queue":"1/1","curr_dt":"YYYY-MM-DD"}`, queues "1/1".."6/2"; response
  `{aData:[{time_from,time_to,queue:<state 1=on/2=swap/3=off>}], aState}`.
- **Blocker:** the API is gated by **Cloudflare Turnstile** — any call without a
  valid token returns `HTTP 400 {"error":"No captcha"}` (CI-confirmed; page loads
  `challenges.cloudflare.com/turnstile/v0/api.js`). The host also serves an
  incomplete TLS chain (needs a real browser / AIA). Beating Turnstile from
  headless CI is fragile; alternatives are also protected (energy-ua.info →
  Cloudflare, cn.e-svitlo.com.ua → login). Revisit only if an unprotected source
  appears or the owner asks.

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
- **No-churn**: `reconcileDocument` keeps the previous file when the *meaningful
  view* — `groups`, `schedules` and `status.ok`/`code` — is unchanged, so the
  upstream "оновлено" stamp (`status.sourceUpdatedAt`), `updatedAt` and the raw
  snapshot are all ignored for change-detection (critical for ztoe, which ticks
  its stamp every ~30 min). `reconcileIndex` ignores `generatedAt`. Per-source
  files (and `index.json`) only change on real change; `updatedAt` = last real
  change. A spurious change here = a spurious Telegram "оновлено" message.
- **Run log**: `appendRunLog` writes one line per run to `data/log.jsonl`
  (capped `MAX_LOG_ENTRIES`=1000). Because it changes every run, the data branch
  gets one commit per run (a heartbeat). If commit volume becomes a problem,
  switch to logging only `changed`/non-ok runs.
- Content hash (`computeHash`, `status.contentHash`) is over `groups+schedules+raw`
  and is informational only — it is NOT used for change-detection (it embeds raw
  upstream timestamps, so it ticks even when the schedule is identical; reconcile
  uses `meaningfulView` instead).
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
runs), `HEADFUL` (`1`/`true` → launch a real on-screen browser; CI sets it and wraps
the run in `xvfb-run` to clear Incapsula), `DTEK_DATA_TIMEOUT_MS` (default 180000),
`DTEK_NAV_TIMEOUT_MS` (45000), `CHROMIUM_EXECUTABLE` (override Chromium path — used
for local sandboxes).
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
