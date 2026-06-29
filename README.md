# dtek-data

Universal collector for power-outage schedules. It renders provider sites with a
real browser, normalizes the data into a stable JSON shape, and publishes it to
the orphan **`data`** branch every ~5 minutes via GitHub Actions.

Designed to be source-agnostic: a small adapter per provider feeds a shared core.

## Sources

| id          | Provider                                   | Region          |
|-------------|--------------------------------------------|-----------------|
| `dtek-krem` | ДТЕК Київські регіональні електромережі    | Київська область|
| `dtek-kem`  | ДТЕК Київські електромережі                 | місто Київ      |

Both DTEK sites embed the schedule in a `window.DisconSchedule` global and sit
behind an Imperva Incapsula challenge, so a headless browser (Playwright) is
required — a plain HTTP fetch only returns the challenge stub.

## Published data

On the `data` branch:

- `data/<source>.json` — full schedule for one provider (all groups/subgroups).
- `data/index.json` — summary of every source (region, last update, status).

Consume the raw files, e.g.:

```
https://raw.githubusercontent.com/<owner>/dtek-data/data/dtek-krem.json
```

### Document shape (`<source>.json`)

```jsonc
{
  "schemaVersion": "1.0",
  "source": { "id": "dtek-krem", "name": "…", "region": "…", "url": "…" },
  "updatedAt": "2026-06-29T12:00:00+03:00",   // when the published data last changed
  "status": {
    "ok": true,
    "code": "ok",                              // ok | waf_blocked | timeout | parse_error | no_data
    "message": null,
    "contentHash": "sha256:…",
    "sourceUpdatedAt": "29.06.2026 12:00"      // upstream label, if available
  },
  "groups": ["1.1", "1.2", "…"],
  "schedules": {
    "1.1": {
      "group": "1",
      "subgroup": "1",
      "intervals": [
        { "start": "2026-06-29T08:00:00+03:00",
          "end":   "2026-06-29T12:00:00+03:00",
          "kind":  "off",        // off | possible
          "type":  "planned",    // planned | possible | emergency | stabilization
          "origin": "preset" }   // preset | fact
      ]
    }
  },
  "raw": { "preset": { /* upstream as-is */ }, "fact": { /* upstream as-is */ } }
}
```

Times are absolute ISO 8601 in the Europe/Kyiv offset (DST-aware). The weekly
template (`preset`) is expanded over a rolling 7-day horizon; same-day actual
data (`fact`) overrides the template for the dates it covers. When a run fails,
the previous `groups`/`schedules`/`raw` are kept and only `status`/`updatedAt`
change — consumers never see an empty file.

A new commit lands on the `data` branch only when something meaningful changes
(schedule, status, or the provider's own `sourceUpdatedAt`); identical re-runs
are skipped, so `updatedAt` marks the last real change rather than the last poll.

## Local usage

```bash
npm ci
npx playwright install --with-deps chromium

node src/index.js                  # all sources -> ./data
node src/index.js --source dtek-krem
node src/index.js --out ./out --attempts 3

npm test                           # unit tests (no browser needed)
```

Env vars: `LOG_LEVEL` (`debug|info|warn|error`), `STORAGE_STATE_PATH` (reuse
browser cookies), `DTEK_DATA_TIMEOUT_MS` (wait for data to load, default 180000).

## Adding a source

1. Create an adapter exposing `{ id, displayName, region, url, fetch, parse }`
   (see `src/sources/dtek/adapter.js`). For another DTEK region, just call
   `createDtekAdapter({...})` as in `src/sources/dtek/dtek-krem.js`.
2. Register it in `src/sources/registry.js`.

The pipeline, normalization helpers, publishing, and CI need no changes.

## Layout

```
src/
  core/      schema, time (Kyiv/ISO), browser (Playwright + Incapsula), pipeline, publish, errors, logger
  sources/   registry + per-provider adapters
test/        unit tests + fixtures
.github/workflows/collect.yml   scheduled run -> data branch
docs/SPEC.md                    full specification
```

## Notes

- GitHub `schedule` workflows run only from the **default branch** and the 5-min
  cron is best-effort (may be delayed/skipped under load).
- Publishing uses the built-in `GITHUB_TOKEN` (`contents: write`); no PAT needed
  to push to the `data` branch of this repo.
