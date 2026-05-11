# Design: `wiki` plugin — persistent knowledge wiki

**Date:** 2026-05-11
**Status:** Approved (brainstorming)
**Inspired by:** [ekadetov/llm-wiki](https://github.com/ekadetov/llm-wiki) — same idea, different shape (no Obsidian, no external deps, skill-per-operation, single wiki per repo).

---

## 1. Цель

Плагин Claude Code, который превращает любой git-репозиторий в постоянно растущую базу знаний под `docs/wiki/`. Все операции — отдельные скиллы. База — обычный markdown, читается и редактируется как код. Никаких внешних зависимостей.

---

## 2. Архитектура

### 2.1 Структура плагина

```
wiki/                               ← плагин (репо или ~/.claude/plugins/wiki/)
├── .claude-plugin/
│   └── plugin.json                 ← манифест (имя=wiki, версия, описание)
├── skills/
│   ├── init/SKILL.md               → /wiki:init
│   ├── ingest/SKILL.md             → /wiki:ingest <path|url|->
│   ├── compile/SKILL.md            → /wiki:compile [<path>]
│   ├── query/SKILL.md              → /wiki:query "<вопрос>"
│   ├── lint/SKILL.md               → /wiki:lint
│   └── _shared/                    ← reference-файлы (frontmatter-schemas.md, compile-guide.md)
└── README.md
```

**Skill-per-operation:** каждый `SKILL.md` автоматически даёт слэш-команду `/wiki:<name>` + автоактивацию по триггер-фразам из `description`. Файлы `commands/` не нужны (deprecated — merged into skills).

**Никаких:** `commands/`, `hooks/`, `scripts/`, бинарных утилит, install-deps.

**Координация скиллов** — через два файла, создаваемых при `/wiki:init`:
1. `<repo>/.claude/rules/wiki.md` — короткое (~25 строк) глобальное правило БЕЗ `paths:`. Грузится при каждой сессии в репо. Уведомляет любого Claude/скилл о наличии вики и команд.
2. `<repo>/docs/wiki/CLAUDE.md` — детальные frontmatter-схемы, naming, link rules, compile rules. Грузится автоматически когда Claude читает любой файл из `docs/wiki/**`.

### 2.2 Обнаружение wiki

Все скиллы кроме `/wiki:init` идут от CWD вверх до первой папки, содержащей `docs/wiki/CLAUDE.md`, либо до корня git-репо (`.git`). Не нашёл — ошибка «`/wiki:init` сначала».

### 2.3 Структура `docs/wiki/`

```
docs/wiki/
├── CLAUDE.md           ← правила и схемы для Claude (auto-loaded при работе с файлами внутри)
├── README.md           ← навигация для человека
├── index.md            ← плоский список всех страниц по типам
├── raw/                ← неизменяемые источники (frontmatter compiled: false/true)
│   ├── articles/       ← ingested URLs
│   ├── files/          ← копии локальных файлов
│   └── pastes/         ← inline-вставки из чата
└── pages/              ← синтезированные страницы (4 типа = 4 подпапки)
    ├── concept/
    ├── person/
    ├── source/         ← source-summary.md файлы
    └── queries/        ← ответы /wiki:query (filed → promoted = перенос в concept/)
```

**Подпапки по типу, а не плоско:** упрощает grep-фильтрацию, glob-патчи, навигацию глазами. Тип во frontmatter обязан совпадать с подпапкой.

---

## 3. Workflow скиллов

### 3.1 `/wiki:init`

**Триггер:** "init wiki", "create wiki", "setup knowledge base"
**Аргументы:** нет

**Алгоритм:**
1. Проверить `git rev-parse --show-toplevel`. Не git → спросить, продолжать ли.
2. Если `docs/wiki/` существует — ошибка «уже есть».
3. Создать каркас `docs/wiki/{raw/{articles,files,pastes},pages/{concept,person,source,queries}}` + `.gitkeep` в пустых.
4. Записать: `docs/wiki/CLAUDE.md`, `docs/wiki/README.md`, `docs/wiki/index.md`.
5. Записать `<repo>/.claude/rules/wiki.md`. Если файл уже есть — не перезаписывать, предупредить.
6. Финальное сообщение пользователю.

**Tools:** Bash, Write, Read.

### 3.2 `/wiki:ingest`

**Триггер:** "ingest", "сохрани в вики", "save source", "add to wiki"
**Аргументы:** `<path|url|->` — путь, URL или `-` (inline-вставка)

**Алгоритм:**
1. Walk up до `docs/wiki/`. Не нашёл → ошибка.
2. Определить тип источника:
   - `^https?://` → WebFetch → `raw/articles/<slug>.md`
   - Существующий файл → Read → `raw/files/<basename>.md`
   - `-` → последний крупный paste из контекста → `raw/pastes/<slug>-<date>.md`
3. Slug из title/URL/filename, kebab-case. Конфликт → суффикс датой.
4. Записать с frontmatter raw-файла (см. §4.1).
5. Сообщить пользователю что записано и предложить `/wiki:compile`.

**Tools:** Read, Write, WebFetch, Bash.
**Edge:** URL-дубликат → предупредить, спросить overwrite. PDF → Read извлечёт текст.

### 3.3 `/wiki:compile`

**Триггер:** "compile", "обработай источники", "synthesize pages"
**Аргументы:** `[<path>]` — конкретный raw-файл; без аргумента → glob по `raw/**` с `compiled: false`

**Алгоритм:**
1. Walk up до `docs/wiki/` (CLAUDE.md подтянется автоматом).
2. Собрать raw-файлы.
3. Для каждого:
   - Read → извлечь сущности/факты (LLM-reasoning, никаких выдумок)
   - Для каждой сущности: страница есть → Edit (добавить факты в нужные секции, обновить `updated`, расширить `sources`); нет → Write с шаблоном по типу
   - Создать `pages/source/<slug>-summary.md`
   - **Backlink audit:** grep по `pages/**/*.md` на упоминания новых заголовков → добавить markdown-ссылку при первом упоминании в каждом файле
   - Frontmatter raw-файла: `compiled: true`, `compiled-to: [...]`
4. Перегенерировать `index.md`.
5. Отчёт: создано N, обновлено M, добавлено K ссылок.

**Tools:** Read, Write, Edit, Grep, Glob.
**Edge:** конфликт фактов → callout-блок (см. §4.4).

### 3.4 `/wiki:query`

**Триггер:** "query wiki", "спроси вики", "что в вики про X"
**Аргументы:** `<question>` — строка вопроса

**Алгоритм:**
1. Walk up до `docs/wiki/`.
2. Извлечь ключевые термины из вопроса.
3. Grep по `pages/**/*.md` + Glob по тегам frontmatter.
4. Read топ-N (N=5-10) релевантных.
5. Сгенерировать ответ с цитатами `[Title](pages/concept/foo.md)`. Мало данных → честно «недостаточно, ингестни X».
6. Записать `pages/queries/<date>-<slug>.md` с frontmatter (см. §4.1).
7. Спросить: «продвинуть в `concept/`?» → Yes: переместить, сменить `type: concept`, `status: active`.
8. Вернуть ответ в чат.

**Tools:** Read, Write, Grep, Glob.
**Edge:** пустой grep → честно «нет данных, ничего не записал».

### 3.5 `/wiki:lint`

**Триггер:** "lint wiki", "проверь вики", "wiki audit"
**Аргументы:** нет

**Алгоритм:**
1. Walk up до `docs/wiki/`.
2. Проверки:
   - **Dead links:** все `[text](path)` указывают на существующий файл
   - **Orphan pages:** страница (кроме `index.md`, `queries/*`) без входящих ссылок
   - **Frontmatter:** обязательные поля по типу, `type:` совпадает с подпапкой
   - **Underlinked:** concept-страница с < 3 исходящими ссылками
   - **Stale:** `status: active` + `updated` старше 90 дней (флаг, не ошибка)
3. Отчёт в чат с file paths. **Ничего не правит автоматически.**

**Tools:** Read, Grep, Glob.

---

## 4. Схемы и правила (содержимое `docs/wiki/CLAUDE.md`)

### 4.1 Frontmatter

**Базовые поля (все 4 типа страниц):**
```yaml
id: <slug>                # = имя файла без .md
type: concept             # concept | person | source | query
title: <human-readable>
created: 2026-05-11       # ISO 8601
updated: 2026-05-11
status: active            # active | stale | draft
tags: [topic1, topic2]
sources: []               # пути в raw/, на которые опирается страница
```

**`concept`** — без дополнительных полей.

**`person`** — без дополнительных полей.

**`source`:**
```yaml
source-url: https://...
source-type: article      # article | paper | transcript | code | doc
```

**`query`:**
```yaml
question: "<оригинал дословно>"
informed-by:
  - pages/concept/foo.md
status: filed             # filed | promoted
```
(базовые: только `id`, `type`, `title`, `created`, `status`, `tags`)

**Raw-файлы (в `raw/`):**
```yaml
id: <slug>
type: raw-article | raw-file | raw-paste
title: <извлечённый>
source-url: <url|null>
source-type: article | paper | transcript | code | doc
ingested: 2026-05-11
compiled: false
compiled-to: []
```

### 4.2 Naming

- Slug = kebab-case, ASCII или транслит, 1-50 символов.
- Конфликт → суффикс датой: `pods.md` занят → `pods-2026-05-11.md`.
- Query-страницы: `<date>-<slug>.md` всегда с датой.
- Подпапка = тип; несовпадение `type:` ↔ подпапка → lint-ошибка.

### 4.3 Link rules

- Только обычный markdown `[text](relative/path.md)`. Никаких `[[wikilinks]]`.
- Пути относительные от файла где ссылка.
- Concept-страница: ≥ 3 исходящих ссылок (правило `/wiki:lint`).
- **Backlink audit при compile обязателен.**
- Ссылка на `raw/` — только в `sources:` frontmatter, не в теле.

### 4.4 Compile rules

- **Никаких выдумок.** Каждое утверждение опирается на текст из `raw/`.
- Concept: 800–2000 слов. Больше → разбить на под-темы.
- Source-summary: 300–600 слов.
- Конфликты фактов — callout-блок в обе страницы:
  ```
  > ⚠️ Conflict: [source A](../source/a-summary.md) утверждает X. [source B](../source/b-summary.md) утверждает Y.
  ```
- Update vs create: страница с тем же id → Edit (не пересоздаём, не дублируем).

### 4.5 Шаблоны тела страниц (рекомендация, не строгая)

**Concept / person:**
````markdown
---
<frontmatter>
---

# <Title>

Краткое определение в 1-2 предложения.

## Ключевые свойства / Key facts
- факт 1 (из [source-summary](../source/foo-summary.md))
- факт 2

## Связанные концепты
- [Related A](./related-a.md) — короткий контекст связи
- [Related B](../person/related-b.md)

## Источники
См. frontmatter `sources:`.
````

**Source-summary:**
````markdown
# Summary: <Original title>

**Original:** [<url>](<url>) · *<source-type>*

## Главные идеи
- идея 1
- идея 2

## Извлечённые концепты
- [Concept A](../concept/a.md)
- [Person X](../person/x.md)
````

**Query-output:**
````markdown
# <Title>

**Q:** <question дословно>

**A:** <короткий ответ, 1-3 абзаца>

## Опирается на
- [Concept A](../concept/a.md) — что взял оттуда
- [Source B summary](../source/b-summary.md)
````

---

## 5. Содержимое `<repo>/.claude/rules/wiki.md`

```markdown
# Project knowledge wiki

This repository has an indexed knowledge wiki at `docs/wiki/`.
- Synthesized pages: `docs/wiki/pages/` (subdirs: concept/, person/, source/, queries/)
- Raw sources: `docs/wiki/raw/` (articles/, files/, pastes/)
- Entry point for humans: `docs/wiki/index.md`

If the user asks a question that might be covered by accumulated project knowledge,
prefer checking the wiki first — either grep/read `docs/wiki/pages/` directly,
or invoke `/wiki:query "<question>"` for synthesized answer with citations.

## Ingesting superpowers artifacts

After a `superpowers:brainstorming` or `superpowers:writing-plans` session writes a
finalized artifact to `docs/superpowers/specs/` or `docs/superpowers/plans/`,
consider ingesting it into the wiki:

1. `/wiki:ingest docs/superpowers/specs/<file>.md` — copies into `raw/files/`
2. `/wiki:compile docs/wiki/raw/files/<file>.md` — synthesizes concept pages

This makes the design/plan knowledge searchable via `/wiki:query`.

**Caveat:** design docs and plans date themselves. If the implementation later
diverges from the doc, the derived concept pages become stale. Mitigate by
re-running `/wiki:lint` (flags `status: active` pages older than 90 days) or
re-ingesting the actual code/README/ADR after merge so the wiki reflects
present-state, not the original intent.

## Maintenance commands (plugin `wiki`)

- `/wiki:ingest <path|url|->` — capture a source into raw/
- `/wiki:compile [path]` — synthesize pages from raw/ sources
- `/wiki:query "<question>"` — search wiki and answer with citations
- `/wiki:lint` — audit links, orphan pages, stale frontmatter

Detailed frontmatter schemas, naming conventions, and link rules are in
`docs/wiki/CLAUDE.md`, which auto-loads when Claude works with files under `docs/wiki/`.
```

---

## 6. Что НЕ делаем (явные исключения)

| Не делаем | Почему |
|---|---|
| `commands/` директория | Skill автоматически даёт `/wiki:<name>`. Дублирование не нужно. |
| `hooks/` | Нет внешних зависимостей → нечего инсталлировать. |
| `scripts/` | Встроенных тулзов Claude Code достаточно. Кросс-платформенность даром. |
| `qmd` / embeddings | Grep + LLM-reasoning достаточно. |
| Obsidian, wikilinks `[[...]]` | Обычный markdown — кликается везде. |
| Multi-wiki в одном репо | Одна вики на репо. Можно расширить позже без ломки. |
| Git auto-commit | Пользователь коммитит сам. |
| `log.md` | Состояние = файлы. Git history + frontmatter покрывают. |
| `/wiki:remove` | Удаляешь руками. Опасная операция не в один клик. |
| Перевод языка | Compile сохраняет язык источника. |
| Авто-исправление в `/wiki:lint` | Только отчёт, решение за пользователем. |

---

## 7. Open questions для плана реализации

- Точный формат plugin.json (см. live-доки на этапе writing-plans).
- Какой тулз использовать для PDF (Read tool извлекает текст напрямую — проверить лимиты).
- Шаблоны тел страниц — встроить в SKILL.md compile или вынести в `_shared/templates/`.
- Detection «inline paste» (`-` аргумент) — как именно скилл определяет «последний крупный paste из контекста». Возможно проще требовать явный текст вторым аргументом.
- Cross-platform: walk-up до `docs/wiki/` — git Bash, PowerShell, чистый Linux — все работают через Glob/Read? Скорее да, но проверить.
