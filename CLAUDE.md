# CLAUDE.md — standup-agent-plugin

Маркетплейс из двух плагинов: корень репо — маркетплейс и исходники. `plugin/` — плагин разработчика для Claude Code (то, что уезжает разработчику), `manager/` — плагин менеджера для Cowork: только скилл `standup-manager` (карточки 6a/6b), без кода и без коннектора (коннектор менеджер подключает сам, иначе инструменты задвоятся). Репо **публичный**: сюда не кладём ничего внутреннего (URL стендов, ключи, данные пилотов).

Продукт, инварианты и правила работы с Trello описаны в `CLAUDE.md` воркспейса: репо `Standup-Agent/standup-agent-docs` (приватный), локально — `../CLAUDE.md`. Задачи этого репо — карточки 1, 2, 3, скилл join из 4 и упаковка из 7.

## Стек

- TypeScript, Node ≥ 22, без рантайм-зависимостей, если без них можно обойтись.
- Сборка: esbuild → `plugin/dist/cli.js`, один файл. **`plugin/dist/` коммитится**, потому что маркетплейс ставит плагин из git без сборки. После любой правки `src/` запусти `npm run build` и закоммить бандл.
- Тесты: vitest. Обезличенные реальные транскрипты Claude Code 2.1.251–2.1.285 лежат в `test/fixtures/transcripts/` (весь текст заменён на `<key:длина>`, структура сохранена). Новые делаются только через `test/fixtures/sanitize.py` — сырые транскрипты в репо не кладём.

## Структура

```
.claude-plugin/marketplace.json  # маркетплейс: standup-agent → ./plugin, standup-agent-manager → ./manager
manager/                         # плагин менеджера (Cowork): .claude-plugin/plugin.json + skills/standup-manager/SKILL.md
plugin/                          # ← только это ставится пользователю
  .claude-plugin/plugin.json     # манифест
  hooks/hooks.json               # SessionStart, SessionEnd → node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js <cmd>
  skills/join/SKILL.md           # (задача 4) узнаёт ссылку standupagent.co/join/<CODE>
  skills/standup/SKILL.md        # /standup: меню, показ стендапа (4 кнопки), заметки и дополнение к отправленному (2a), приватность при join (4b), разметка репо
  skills/synth/SKILL.md          # context: fork + background: false → субагент standup-synth синхронно
  agents/standup-synth.md        # субагент синтеза: материалы из `standup prepare`, шаг A → `standup save-digests`, возвращает только стендап + blocker_hint
  prompts/standup.fallback.md    # запасная копия промпта синтеза (основной — GET /prompts/standup, кэш на день)
  dist/cli.js                    # собранный бандл, коммитится
src/
  cli.ts                 # точка входа: session-start | session-end | capture | repos
  commands/repos.ts      # repos scan | set <path>=work|personal | list — вызывает Claude через Bash, печатает JSON
  standup/schedule.ts    # когда показывать: ≥ 6:00, не отправлен/пропущен сегодня, не отложен, не показывается в другом терминале
  standup/materials.ts   # материалы для синтеза: сырьё после last_checkin + коммиты вне сессий, части до 24 КБ (байты UTF-8: лимит вывода Bash ~30 КБ)
  standup/commands.ts    # standup prepare [--part N] | send '<json>' | save-digests '<json>' | snooze | event edited|blocker | status | note add|list|rm | addendum '<json>'
  standup/notes.ts       # заметки разработчика к стендапу (2a): notes.jsonl, фильтр секретов, ветка и тикет только в рабочем репо
  api.ts                 # очередь queue/ → POST /reports, /events; ретрай при следующем старте (`cli.js flush`)
  prompt.ts              # промпт синтеза с сервера / запасной
  hookio.ts              # чтение и разбор stdin хука
  hooks/                 # session-start.ts, session-end.ts (только спавнит воркер)
  capture/worker.ts      # отсоединённый воркер после SessionEnd: репо по cwd каждой записи, куски репо/ветка/день
  capture/budget.ts      # бюджет по ходам: все запросы и итог каждого хода, середина прореживается, а не выпадает
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
                                   # last_capture_at, captures{session_id→mtime транскрипта при захвате},
                                   # unmarked_seen{repo→{last_seen, sessions{id→путь транскрипта}}} — неразмеченные репо, куда заходили сессии (только пути)
auth.json                          # member_token (не логировать)
digests/<repo>/<branch>/raw/<session>_<YYYY-MM-DD>.json # сырьё: сессия × репо × ветка × локальный день, TTL 30 дней от последней активности (mtime файла)
                                   # <repo> = имя-<8 hex sha256 пути>, <branch> = encodeURIComponent(ветка)
digests/<repo>/<branch>/digest.md  # приватный дайджест ветки (шаг A промпта: Goal/Done/Why/State/Left), переписывается синтезом, не уходит наружу
notes.jsonl                        # заметки к следующему стендапу (2a): текст, время, ветка/тикет в рабочем репо; уходят только внутри подтверждённого стендапа, после отправки удаляются
queue/*.json                       # неотправленные репорты, дополнения и события (ретрай, идемпотентность по id)
prompt-cache.json                  # {version, text, fetched_at}, кэш на день
```

## Правила для хуков

- **Никаких вызовов LLM** и `claude -p` из хуков: это тратит токены, вызывает рекурсию через наш же SessionEnd и тормозит выход.
- **SessionEnd живёт ~1,5 с**, и `timeout` в hooks.json этот бюджет не поднимает (проверено 30.09.2026). Поэтому хук только запускает отсоединённый воркер (`spawn(process.execPath, [...], {detached: true, stdio: 'ignore'}).unref()`) и сразу выходит. Разбор транскрипта и git делает воркер. После `kill -9` SessionEnd не приходит — это закрывает страховка на SessionStart.
- `CLAUDE_PLUGIN_DATA` переживает `plugin update`, но **удаляется при `plugin uninstall`**. Всё, что там лежит, должно восстанавливаться повторным join.
- Хук должен быть быстрым и ничего не ломать. Любая ошибка логируется в `$CLAUDE_PLUGIN_DATA/log/`, а хук завершается с кодом 0. Сессия пользователя важнее стендапа.
- Формат транскриптов не документирован, поэтому парсер живёт только в `capture/transcript.ts`, падает мягко и логирует нераспознанное.
- Из транскрипта берём только тексты пользователя и Claude, без вывода инструментов и диффов. Лимит — десятки КБ на кусок (сессия × репо × ветка × день).
- `~/.claude.json` не читаем вообще: там OAuth-токены Claude, и портал каталога помечает это как использование учётных данных. Имя и email для join — из `git config --global user.name/email`, пользователь подтверждает или правит их; если в git пусто, Claude спрашивает.
- **Разрешения (проверено 30.09.2026, режим default).** CLI, который Claude запускает через Bash, не получает `CLAUDE_PLUGIN_DATA` из окружения — путь передаётся аргументом `--data ${CLAUDE_PLUGIN_DATA}`. Без запроса разрешения команды идут только по правилу `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js *)` из скилла, поэтому команда пишется **ровно** `node <root>/dist/cli.js --data <data> …` без кавычек и префиксов. Правило живёт до следующего хода: ответ на AskUserQuestion — тот же ход, а новое сообщение пользователя или завершение фонового субагента — новый, и тогда скилл надо вызвать заново (`continue`). `Read` файлов из папки данных всегда спрашивает разрешение — материалы отдаются через вывод Bash. Субагент через Agent уходит в фон и ломает ход — синтез идёт через скилл с `context: fork` + `background: false`. Разовые запросы «Use skill?» при первом авто-вызове каждого скилла остаются.
- Результат forked-скилла пользователь не видит: текст стендапа кладётся прямо в `question` AskUserQuestion, `blocker_hint` — строкой «💡 …» под ним, не в текст и не в `blockers`.
- Промпт синтеза — Алексея (`standup-v1`, на сервере `GET /prompts/standup`, копия в `plugin/prompts/standup.fallback.md`). Его текст не правим: служебное (repo_id, язык) передаётся через материалы и инструкцию субагента.
- Неразмеченный репо не захватывается. Директории без git пропускаем. Ключ разметки в `state.repos` — вывод `git rev-parse --show-toplevel`; worktree засчитывается по основному checkout.
- **Репо определяется по `cwd` каждой записи транскрипта**, а не по `cwd` из SessionEnd: сессия может начаться в одном репо и закончиться в другом. Записи из личных и неразмеченных репо отбрасываются в парсере до фильтра секретов. Неразмеченные пути запоминаются в `unmarked_seen`: о них спросят на SessionStart, а `repos set …=work` захватит эти сессии.
- Каждый захват переписывает сессию целиком: сначала удаляет все её сырые файлы, потом пишет куски заново. Бюджет `rawMaxBytesPerSegment` — на кусок, а не на сессию.
- Заметки (`/standup <текст>`) пишутся без LLM, с фильтром секретов; ветку и тикет к ним добавляем, только если заметка написана в рабочем репо. В материалы синтеза идут все заметки (`developer_notes`), `send` удаляет те, что были в показанном стендапе, «Не сейчас» их сохраняет.
- Сводку компакции Claude Code (`isCompactSummary`) берём, только если до неё сессия не заходила в неразмеченный или личный репо: иначе сводка может пересказывать их.
- `standup prepare` перед сборкой материалов дозахватывает сессии рабочих репо, изменённые после последнего захвата (в том числе текущую), — стендап видит и незакрытые сессии.
- Страховка на SessionStart только читает каталоги и `stat`, содержимое транскриптов не открывает; найденное отдаёт отсоединённому воркеру `capture '<json-массив jobs>'`.

## Контракт с сервером

Источник правды — `api/openapi.yaml` в репо `Standup-Agent/standup-agent-server` (локально `../standup-agent-server/`). Репорт: `id` (UUID, генерирует плагин), `date`, `period {from, to}`, `items [{ticket, branch, done, why, next}]`, `blockers []`, `text`, `prompt_version`. Дополнение к отправленному сегодня репорту: `POST /reports/{id}/addendum {id, text, ticket}`, id репорта — `state.standup.sent_report_id`. Команду и участника сервер берёт из `member_token`, поэтому плагин их не шлёт.

ID тикета ищем по ветке и коммитам регэкспом `[A-Z][A-Z0-9]+-\d+`.

## Проверка

- `npm test` — юнит-тесты: парсер, фильтр секретов, классификация, state.
- `npm run typecheck && npm test && npm run build && npm run validate` перед коммитом.
- Ручная проверка: `CLAUDE_CODE_AUTO_CONNECT_IDE=false claude --plugin-dir <repo>/plugin` в тестовом репо (без IDE, иначе в сессию подмешивается выделение из редактора). Данные при `--plugin-dir` лежат в `~/.claude/plugins/data/standup-agent-inline/`. Отдельно проверь `/clear`, закрытие окна и убитый терминал (страховка на SessionStart).
