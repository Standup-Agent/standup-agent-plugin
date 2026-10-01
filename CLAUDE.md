# CLAUDE.md — standup-agent-plugin

Маркетплейс из одного плагина: корень репо — маркетплейс и исходники, сам плагин (то, что уезжает пользователю) — `plugin/`. Репо **публичный**: сюда не кладём ничего внутреннего (URL стендов, ключи, данные пилотов).

Продукт, инварианты и правила работы с Trello описаны в `CLAUDE.md` воркспейса: репо `Standup-Agent/standup-agent-docs` (приватный), локально — `../CLAUDE.md`. Задачи этого репо — карточки 1, 2, 3, скилл join из 4 и упаковка из 7.

## Стек

- TypeScript, Node ≥ 22, без рантайм-зависимостей, если без них можно обойтись.
- Сборка: esbuild → `plugin/dist/cli.js`, один файл. **`plugin/dist/` коммитится**, потому что маркетплейс ставит плагин из git без сборки. После любой правки `src/` запусти `npm run build` и закоммить бандл.
- Тесты: vitest. Обезличенные реальные транскрипты Claude Code 2.1.251–2.1.285 лежат в `test/fixtures/transcripts/` (весь текст заменён на `<key:длина>`, структура сохранена). Новые делаются только через `test/fixtures/sanitize.py` — сырые транскрипты в репо не кладём.

## Структура

```
.claude-plugin/marketplace.json  # маркетплейс, source: "./plugin"
plugin/                          # ← только это ставится пользователю
  .claude-plugin/plugin.json     # манифест
  hooks/hooks.json               # SessionStart, SessionEnd → node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js <cmd>
  skills/join/SKILL.md           # (задача 4) узнаёт ссылку standupagent.co/join/<CODE>
  skills/standup/SKILL.md        # /standup: показ стендапа (4 кнопки), разметка репо (repos, repos scan)
  skills/synth/SKILL.md          # context: fork + background: false → субагент standup-synth синхронно
  agents/standup-synth.md        # субагент синтеза: материалы из `standup prepare`, шаг A → `standup save-digests`, возвращает только стендап + blocker_hint
  prompts/standup.fallback.md    # запасная копия промпта синтеза (основной — GET /prompts/standup, кэш на день)
  dist/cli.js                    # собранный бандл, коммитится
src/
  cli.ts                 # точка входа: session-start | session-end | capture | repos
  commands/repos.ts      # repos scan | set <path>=work|personal | list — вызывает Claude через Bash, печатает JSON
  standup/schedule.ts    # когда показывать: ≥ 6:00, не отправлен/пропущен сегодня, не отложен, не показывается в другом терминале
  standup/materials.ts   # материалы для синтеза: сырьё после last_checkin + коммиты вне сессий, части по 25 000 символов
  standup/commands.ts    # standup prepare [--part N] | send '<json>' | save-digests '<json>' | snooze | event edited|blocker
  api.ts                 # очередь queue/ → POST /reports, /events; ретрай при следующем старте (`cli.js flush`)
  prompt.ts              # промпт синтеза с сервера / запасной
  hookio.ts              # чтение и разбор stdin хука
  hooks/                 # session-start.ts, session-end.ts (только спавнит воркер)
  capture/worker.ts      # отсоединённый воркер после SessionEnd
  capture/discover.ts    # поиск транскриптов репо по ~/.claude/projects (страховка, дозапись после разметки)
  capture/transcript.ts  # (задача 1) ЕДИНСТВЕННОЕ место, знающее формат транскрипта
  capture/git.ts         # (задача 1)
  secrets.ts             # (задача 1) фильтр секретов перед записью в склад
  repos.ts               # скан ~/.claude/projects, remote → организация команды, repoOf()
  store.ts / state.ts    # склад дайджестов с TTL; state.json и блокировки
  api.ts                 # клиент сервера, офлайн-очередь
  config.ts              # все [ДЕФОЛТ]-значения (DEFAULTS) и лимиты захвата, которых нет на доске (CAPTURE)
  paths.ts, log.ts, fsutil.ts (атомарная запись)
test/
```

## Локальные данные (`$CLAUDE_PLUGIN_DATA`)

```
state.json                         # last_checkin, shown_at/lock, snooze_until, repos{path→work|personal}, member,
                                   # last_capture_at, captures{session_id→mtime транскрипта при захвате}
auth.json                          # member_token (не логировать)
digests/<repo>/<branch>/raw/*.json # сырьё сессий, TTL 30 дней от последней активности (mtime файла)
                                   # <repo> = имя-<8 hex sha256 пути>, <branch> = encodeURIComponent(ветка)
digests/<repo>/<branch>/digest.md  # приватный дайджест ветки (шаг A промпта: Goal/Done/Why/State/Left), переписывается синтезом, не уходит наружу
queue/*.json                       # неотправленные репорты (ретрай, идемпотентность по report.id)
prompt-cache.json                  # {version, text, fetched_at}, кэш на день
```

## Правила для хуков

- **Никаких вызовов LLM** и `claude -p` из хуков: это тратит токены, вызывает рекурсию через наш же SessionEnd и тормозит выход.
- **SessionEnd живёт ~1,5 с**, и `timeout` в hooks.json этот бюджет не поднимает (проверено 30.09.2026). Поэтому хук только запускает отсоединённый воркер (`spawn(process.execPath, [...], {detached: true, stdio: 'ignore'}).unref()`) и сразу выходит. Разбор транскрипта и git делает воркер. После `kill -9` SessionEnd не приходит — это закрывает страховка на SessionStart.
- `CLAUDE_PLUGIN_DATA` переживает `plugin update`, но **удаляется при `plugin uninstall`**. Всё, что там лежит, должно восстанавливаться повторным join.
- Хук должен быть быстрым и ничего не ломать. Любая ошибка логируется в `$CLAUDE_PLUGIN_DATA/log/`, а хук завершается с кодом 0. Сессия пользователя важнее стендапа.
- Формат транскриптов не документирован, поэтому парсер живёт только в `capture/transcript.ts`, падает мягко и логирует нераспознанное.
- Из транскрипта берём только тексты пользователя и Claude, без вывода инструментов и диффов. Лимит — десятки КБ на сессию.
- Из `~/.claude.json` читаем только `oauthAccount.displayName` и `emailAddress`. Файл содержит токены: не логировать, не копировать. Если полей нет, берём `git config user.name/email`.
- **Разрешения (проверено 30.09.2026, режим default).** CLI, который Claude запускает через Bash, не получает `CLAUDE_PLUGIN_DATA` из окружения — путь передаётся аргументом `--data ${CLAUDE_PLUGIN_DATA}`. Без запроса разрешения команды идут только по правилу `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js *)` из скилла, поэтому команда пишется **ровно** `node <root>/dist/cli.js --data <data> …` без кавычек и префиксов. Правило живёт до следующего хода: ответ на AskUserQuestion — тот же ход, а новое сообщение пользователя или завершение фонового субагента — новый, и тогда скилл надо вызвать заново (`continue`). `Read` файлов из папки данных всегда спрашивает разрешение — материалы отдаются через вывод Bash. Субагент через Agent уходит в фон и ломает ход — синтез идёт через скилл с `context: fork` + `background: false`. Разовые запросы «Use skill?» при первом авто-вызове каждого скилла остаются.
- Результат forked-скилла пользователь не видит: текст стендапа кладётся прямо в `question` AskUserQuestion, `blocker_hint` — строкой «💡 …» под ним, не в текст и не в `blockers`.
- Промпт синтеза — Алексея (`standup-v1`, на сервере `GET /prompts/standup`, копия в `plugin/prompts/standup.fallback.md`). Его текст не правим: служебное (repo_id, язык) передаётся через материалы и инструкцию субагента.
- Неразмеченный репо не захватывается. Директории без git пропускаем. Ключ разметки в `state.repos` — вывод `git rev-parse --show-toplevel`; worktree засчитывается по основному checkout.
- Страховка на SessionStart только читает каталоги и `stat`, содержимое транскриптов не открывает; найденное отдаёт отсоединённому воркеру `capture '<json-массив jobs>'`.

## Контракт с сервером

Источник правды — `api/openapi.yaml` в репо `Standup-Agent/standup-agent-server` (локально `../standup-agent-server/`). Репорт: `id` (UUID, генерирует плагин), `date`, `period {from, to}`, `items [{ticket, branch, done, why, next}]`, `blockers []`, `text`, `prompt_version`. Команду и участника сервер берёт из `member_token`, поэтому плагин их не шлёт.

ID тикета ищем по ветке и коммитам регэкспом `[A-Z][A-Z0-9]+-\d+`.

## Проверка

- `npm test` — юнит-тесты: парсер, фильтр секретов, классификация, state.
- `npm run typecheck && npm test && npm run build && npm run validate` перед коммитом.
- Ручная проверка: `CLAUDE_CODE_AUTO_CONNECT_IDE=false claude --plugin-dir <repo>/plugin` в тестовом репо (без IDE, иначе в сессию подмешивается выделение из редактора). Данные при `--plugin-dir` лежат в `~/.claude/plugins/data/standup-agent-inline/`. Отдельно проверь `/clear`, закрытие окна и убитый терминал (страховка на SessionStart).
