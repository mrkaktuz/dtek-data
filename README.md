# dtek-data

[![Збір розкладів](https://github.com/mrkaktuz/dtek-data/actions/workflows/collect.yml/badge.svg)](https://github.com/mrkaktuz/dtek-data/actions/workflows/collect.yml)
![останнє оновлення](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fstatus.json&cacheSeconds=300)
![ДТЕК КРЕМ](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fdtek-krem.json&cacheSeconds=300)
![ДТЕК КЕМ](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fdtek-kem.json&cacheSeconds=300)
![ДТЕК ДНЕМ](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fdtek-dnem.json&cacheSeconds=300)
![ДТЕК ОЕМ](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fdtek-oem.json&cacheSeconds=300)
![Житомиробленерго](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fztoe.json&cacheSeconds=300)
![Миколаївобленерго](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrkaktuz%2Fdtek-data%2Fdata%2Fbadges%2Fmykolaiv.json&cacheSeconds=300)

Універсальний збирач графіків відключень електроенергії. Рендерить сайти
операторів реальним браузером, нормалізує дані в стабільний JSON і кожні ~5 хв
публікує його в окрему orphan-гілку **`data`** через GitHub Actions.

Архітектура незалежна від джерела: спільне ядро + по одному адаптеру на оператора.

## Джерела

| id          | Оператор                                    | Регіон             |
|-------------|---------------------------------------------|--------------------|
| `dtek-krem` | ДТЕК Київські регіональні електромережі     | Київська область   |
| `dtek-kem`  | ДТЕК Київські електромережі                  | місто Київ         |
| `dtek-dnem` | ДТЕК Дніпровські електромережі              | Дніпропетровська область |
| `dtek-oem`  | ДТЕК Одеські електромережі                  | Одеська область    |
| `ztoe`      | Житомиробленерго                            | Житомирська область |
| `mykolaiv`  | Миколаївобленерго                           | Миколаївська область |

Незалежно від того, як саме оператор віддає дані, колектор зводить усе до одного
формату. Джерела відрізняються механізмом отримання:

- **ДТЕК** (`dtek-krem`, `dtek-kem`, `dtek-dnem`, `dtek-oem`) вбудовує розклад у глобальний об'єкт
  `window.DisconSchedule` і стоїть за анти-бот захистом Imperva Incapsula, тому
  потрібен headless-браузер — звичайний HTTP-запит повертає лише заглушку.
- **Житомиробленерго** (`ztoe`) віддає розклад звичайним HTML — таблицею з
  кольоровими комірками (червона = відключення) по 48 півгодинних слотів на чергу.
  Колектор рендерить сторінку браузером (вона у `windows-1251`) і перетворює
  таблицю в ту саму структуру `DisconSchedule`, що й ДТЕК.
- **Миколаївобленерго** (`mykolaiv`) має відкритий JSON-API (`off.energy.mk.ua`,
  без анти-бот захисту), тож збирається без браузера — три ендпоінти (черги,
  півгодинні слоти, активний розклад) об'єднуються в інтервали.

## Опубліковані дані

У гілці `data`:

- `data/<source>.json` — повний розклад одного оператора (усі групи/підгрупи);
- `data/index.json` — зведення по всіх джерелах (регіон, час оновлення, статус);
- `data/log.jsonl` — історія запусків, по одному JSON-об'єкту на рядок
  (найновіші — в кінці, зберігаються останні 1000 запусків);
- `data/badges/<source>.json` та `data/badges/status.json` — Shields.io
  endpoint-бейджі стану кожного джерела та загальний «останнє оновлення».

Споживати напряму, напр.:

```
https://raw.githubusercontent.com/mrkaktuz/dtek-data/data/dtek-krem.json
```

### Формат документа (`<source>.json`)

```jsonc
{
  "schemaVersion": "1.0",
  "source": { "id": "dtek-krem", "name": "…", "region": "…", "url": "…" },
  "updatedAt": "2026-06-29T12:00:00+03:00",   // коли дані востаннє реально змінились
  "status": {
    "ok": true,
    "code": "ok",                              // ok | waf_blocked | timeout | parse_error | no_data
    "message": null,
    "contentHash": "sha256:…",
    "sourceUpdatedAt": "29.06.2026 12:00"      // мітка «оновлено» з самого сайту, якщо є
  },
  "groups": ["1.1", "1.2", "…"],
  "schedules": {
    "1.1": {
      "group": "1",
      "subgroup": "1",
      "name": "Черга 1.1",
      "intervals": [
        { "start": "2026-06-29T08:00:00+03:00",
          "end":   "2026-06-29T12:00:00+03:00",
          "kind":  "off",        // off | possible
          "type":  "planned",    // planned | possible | emergency | stabilization
          "origin": "preset" }   // preset | fact
      ]
    }
  },
  "raw": { "preset": { /* як на сайті */ }, "fact": { /* як на сайті */ } }
}
```

Час — абсолютний ISO 8601 з київським зсувом (з урахуванням переходу на літній/
зимовий). Тижневий шаблон (`preset`) розгортається на горизонт 7 днів; фактичні
дані на сьогодні/завтра (`fact`) перекривають шаблон на свої дати. При збої
попередні `groups`/`schedules`/`raw` зберігаються, змінюються лише `status`/
`updatedAt` — споживач ніколи не отримає порожній файл.

Файли джерел змінюються лише за змістовної зміни (розклад, статус або власна
мітка `sourceUpdatedAt` оператора), тож `updatedAt` означає останню реальну
зміну, а не час опитування. Натомість `log.jsonl` фіксує **кожен** запуск, тож
гілка `data` отримує по одному коміту на запуск (heartbeat):

```jsonc
{ "runAt": "2026-06-29T13:33:55+03:00", "durationMs": 1200, "ok": true,
  "changed": true,                                  // чи змінився хоч один файл джерела
  "sources": [
    { "id": "dtek-krem", "status": "ok", "ok": true, "groups": 12,
      "changed": true, "sourceUpdatedAt": "29.06.2026 10:23" }
  ] }
```

## Локальний запуск

```bash
npm ci
npx playwright install --with-deps chromium

node src/index.js                  # усі джерела -> ./data
node src/index.js --source dtek-krem
node src/index.js --out ./out --attempts 3

npm test                           # юніт-тести (браузер не потрібен)
```

Змінні середовища: `LOG_LEVEL` (`debug|info|warn|error`), `STORAGE_STATE_PATH`
(зберігати cookies браузера між запусками), `DTEK_DATA_TIMEOUT_MS` (очікування
завантаження даних, типово 180000).

## Додати джерело

1. Створіть адаптер `{ id, displayName, region, url, fetch, parse }`
   (див. `src/sources/dtek/adapter.js`). Для іншого регіону ДТЕК достатньо
   викликати `createDtekAdapter({...})`, як у `src/sources/dtek/dtek-krem.js`.
2. Зареєструйте його в `src/sources/registry.js`.

Ядро, нормалізація, публікація та CI змін не потребують.

## Структура

```
src/
  core/      schema, time (Київ/ISO), browser (Playwright + Incapsula),
             pipeline, publish, errors, logger
  sources/   реєстр + адаптери операторів
test/        юніт-тести + фікстури
.github/workflows/collect.yml   запуск за розкладом -> гілка data
AGENTS.md                       контекст проєкту для розробників/агентів
```

## Сповіщення в Telegram (опційно)

Колектор може слати повідомлення в Telegram:

- **оновлення графіків** (змінився розклад) — беззвучно;
- **збій** джерела та **відновлення** після збою — зі звуком;
- коли все стабільно — нічого (без спаму).

Токен бота **не зберігається в репозиторії** — лише як зашифровані секрети
GitHub Actions (маскуються в логах). У **Settings → Secrets and variables →
Actions** додайте:

- `TELEGRAM_BOT_TOKEN` — токен бота від @BotFather;
- `TELEGRAM_CHAT_ID` — chat id (напр. від @userinfobot; для груп — від'ємний);
- `TELEGRAM_THREAD_ID` — *опційно*, id підтеми (topic) для груп-форумів.

Без цих секретів сповіщення просто вимкнені.

## Запуск через зовнішній планувальник

Єдиний тригер workflow — `workflow_dispatch`. GitHub-cron свідомо не
використовується (best-effort/тротлиться, жоден інтервал не гарантований).
Запуск ініціює зовнішній планувальник (systemd timer / cron на сервері,
cron-job.org, UptimeRobot тощо) через GitHub API.

Безтокенового URL немає — потрібен fine-grained PAT на цей репозиторій з правом
**Actions: read and write**:

- **URL:** `https://api.github.com/repos/<owner>/dtek-data/actions/workflows/collect.yml/dispatches`
- **Method:** `POST`, **Body:** `{"ref":"main"}`
- **Headers:** `Authorization: Bearer <PAT>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`
- Успіх — `204 No Content`. PAT зберігається лише в планувальнику.

**Без накладок.** Одна збірка триває ~3–4 хв. Workflow має
`concurrency: collect` (паралельні запуски не виконуються — максимум один у
черзі), а на сервері варто додатково пропускати dispatch, якщо запуск уже
активний — тоді фактичний інтервал ніколи не буде меншим за тривалість збірки:

```bash
API=https://api.github.com/repos/<owner>/dtek-data/actions/workflows/collect.yml
active=$(curl -fsS -K dispatch.curl.conf "$API/runs?per_page=20" \
  | jq '[.workflow_runs[]|select(.status=="queued" or .status=="in_progress")]|length')
[ "${active:-0}" -gt 0 ] && { echo "busy"; exit 0; }
curl -fsS -K dispatch.curl.conf -X POST "$API/dispatches" -d '{"ref":"main"}'
```

## Примітки

- `schedule`-workflow запускається лише з default-гілки, а 5-хвилинний cron —
  best-effort (може затримуватись/пропускатись під навантаженням).
- Публікація використовує вбудований `GITHUB_TOKEN` (`contents: write`); PAT для
  пушу в гілку `data` цього репозиторію не потрібен.
- Інтеграція для Home Assistant планується окремим репозиторієм і споживатиме
  опублікований тут JSON.
