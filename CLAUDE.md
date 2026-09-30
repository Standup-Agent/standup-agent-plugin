# CLAUDE.md — standup-agent-plugin

Маркетплейс из одного плагина: корень репо — маркетплейс и исходники, сам плагин (то, что уезжает пользователю) — `plugin/`. Репо **публичный**: сюда не кладём ничего внутреннего (URL стендов, ключи, данные пилотов).

Продукт, инварианты и правила работы с Trello описаны в `../CLAUDE.md`. Задачи этого репо — карточки 1, 2, 3, скилл join из 4 и упаковка из 7.

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
  skills/join/SKILL.md           # (задача 4) узнаёт ссылку standupagent.ai/join/<CODE>
  skills/standup/SKILL.md        # (задача 2) /standup [repos|join <CODE>|leave], показ + 4 опции
  agents/standup-synth.md        # (задача 1) субагент синтеза: возвращает только готовый стендап
  prompts/standup.fallback.md    # (задача 2) запасная копия промпта синтеза
  dist/cli.js                    # собранный бандл, коммитится
src/
  cli.ts                 # точка входа: session-start | session-end | capture
  hookio.ts              # чтение и разбор stdin хука
  hooks/                 # session-start.ts, session-end.ts (только спавнит воркер)
  capture/worker.ts      # отсоединённый воркер после SessionEnd
  capture/transcript.ts  # (задача 1) ЕДИНСТВЕННОЕ место, знающее формат транскрипта
  capture/git.ts         # (задача 1)
  secrets.ts             # (задача 1) фильтр секретов перед записью в склад
  repos.ts               # (задача 3) скан ~/.claude/projects, рабочий/личный
  store.ts / state.ts    # склад дайджестов с TTL; state.json и блокировки
  api.ts                 # клиент сервера, офлайн-очередь
  config.ts              # все [ДЕФОЛТ]-значения
  paths.ts, log.ts
test/
```

## Локальные данные (`$CLAUDE_PLUGIN_DATA`)

```
state.json                         # last_checkin, shown_at/lock, snooze_until, repos{path→work|personal}, member
auth.json                          # member_token (не логировать)
digests/<repo>/<branch>/raw/*.json # сырьё сессий, TTL 30 дней
digests/<repo>/<branch>/digest.md  # синтезированный дайджест ветки, дополняется
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
- Неразмеченный репо не захватывается. Директории без git пропускаем.

## Контракт с сервером

Источник правды — `../standup-agent-server/api/openapi.yaml`. Репорт: `id` (UUID, генерирует плагин), `date`, `period {from, to}`, `items [{ticket, branch, done, why, next}]`, `blockers []`, `text`, `prompt_version`. Команду и участника сервер берёт из `member_token`, поэтому плагин их не шлёт.

ID тикета ищем по ветке и коммитам регэкспом `[A-Z][A-Z0-9]+-\d+`.

## Проверка

- `npm test` — юнит-тесты: парсер, фильтр секретов, классификация, state.
- `npm run typecheck && npm test && npm run build && npm run validate` перед коммитом.
- Ручная проверка: `CLAUDE_CODE_AUTO_CONNECT_IDE=false claude --plugin-dir <repo>/plugin` в тестовом репо (без IDE, иначе в сессию подмешивается выделение из редактора). Данные при `--plugin-dir` лежат в `~/.claude/plugins/data/standup-agent-inline/`. Отдельно проверь `/clear`, закрытие окна и убитый терминал (страховка на SessionStart).
