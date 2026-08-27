---
Контекст: базовые обязательные инструкции для агентов в проекте Edvibe School API MCP.
Тип: agent instructions
Продукт: Edvibe
Статус: действует
Связано с:
  - "[[CONTEXT]]"
  - "[[PLAN]]"
tags:
  - agents
  - edvibe
  - mcp
created: 2026-08-22
updated: 2026-08-22
---

# AGENTS.md

## Назначение проекта

Этот репозиторий создаёт официальный MCP-сервер поверх Edvibe School API. Сначала проект работает как личный приватный пилот Руслана, затем передаётся в организацию Edvibe, проходит закрытую бету и только после этого публикуется.

## Что читать в начале

Перед любыми действиями полностью прочитай:

1. `README.md`;
2. `CONTEXT.md`;
3. `PLAN.md`.

Не проси Руслана повторять сведения, которые уже зафиксированы в этих файлах. Если текущий API или состояние Postman расходятся с документацией, сначала покажи расхождение и предложи обновление контекста.

## Язык

- С Русланом общайся на русском.
- Внутренние планы и handoff-заметки по умолчанию пиши на русском.
- Все публичные MCP-артефакты пиши на английском: tool names, `operationId`, descriptions, examples, error messages, onboarding, public README, Postman descriptions и catalog listing.
- Меньше используй необязательные англицизмы в русской документации.

## Неизменяемый объём API

- Аудитория v1 — Pro/API-enabled школы. Не обещай поддержку тарифов без School API; расширение доступности является продуктовой зависимостью Edvibe.

- Сохраняй все **78** операции официального School API. Не исключай методы ради упрощения генерации или тестирования без прямого решения Руслана и Edvibe.
- Контрольная классификация: **35 read + 24 write + 17 high-risk + 2 sensitive = 78**.
- Полный инвентарь находится в `CONTEXT.md`.
- Определяй риск по фактическому поведению, а не по HTTP-методу. В частности, `GET /api/Marathon/AddMarathonNewStudents` меняет состояние, а часть `POST`-методов только читает данные.
- Если upstream OpenAPI изменился, сохрани новый snapshot, покажи diff и отдельно согласуй изменение публичного MCP-контракта.

## Приоритет источников

Используй источники в таком порядке:

1. официальный raw OpenAPI Edvibe;
2. официальный Swagger UI Edvibe;
3. подтверждённое фактическое поведение на mock или разрешённой тестовой школе;
4. официальная документация Postman, MCP, Codex и Cursor;
5. help center Edvibe;
6. внутренние решения из `CONTEXT.md` и `PLAN.md`.

Если Swagger, help center и поведение расходятся, ничего не домысливай: зафиксируй формальное описание, фактическое поведение и вопрос для product/engineering. Спорные операции удаления и Marathon должны быть подтверждены Димой/Полиной перед публичным запуском.

## Работа со схемой и Postman

- Никогда не редактируй сохранённый upstream OpenAPI snapshot.
- Все исправления выполняй воспроизводимым overlay/script; generated output не правь вручную.
- Проверяй, что normalized spec, Postman collection и MCP manifest содержат одинаковые 78 операции.
- Postman Collection генерируется локально скриптом `scripts/generate-postman-collection.cjs`. Postman-аккаунт и workspace не требуются для пилота.
- Postman MCP Generator не используется — сервер написан вручную.
- Публикация в Postman MCP Catalog — опциональный шаг, не блокирующий запуск (см. PLAN.md → Approval gates → опциональные шаги).
- Не сохраняй account ID, workspace ID, email и другие лишние данные аккаунта в документации.

## API-специфика

- Полный upstream URL: `https://{SchoolDomain}/school-api/{Endpoint}`.
- Upstream принимает API-ключ как raw значение заголовка `Authorization`, без `Bearer`.
- Публичный MCP может принять `Authorization: Bearer <EDVIBE_API_KEY>`, но обязан снять префикс перед upstream-вызовом.
- Для выбора школы используй отдельный hostname `X-Edvibe-School-Domain` или локальную настройку STDIO.
- Поддерживай обычные Edvibe и White Label домены.
- Upstream-лимит — 15 запросов/с на токен. В MCP используй безопасный внутренний предел 10 запросов/с и максимум 4 одновременных запроса на ключ.
- `HTTP 200` с `BaseResponse.isSuccess=false` — ошибка, а не успех.
- Никогда не отдавай `errorStackTrace` клиенту.
- Не повторяй автоматически изменяющие запросы.

## Секреты и персональные данные

- Никогда не проси присылать API-ключ или login-токен в чат.
- API-ключ никогда не возвращай в tool result и не сохраняй в Git, Markdown, fixtures, examples, snapshots, Postman shared environment, БД, telemetry, logs, exceptions или кэше.
- **Никогда не передавай API-ключ в командной строке shell.** Это утечка в историю shell, `ps aux` и логи Devin CLI. MCP-сервер получает ключ через `env` блок в `mcp_config.json` — это единственный источник. Если ключ нужен в shell-сессии, используй `export`, а не inline-присваивание в команде.
- PII возвращай только авторизованному клиенту и только если успешный контракт конкретной операции этого требует; сокращай результат до необходимых полей и не сохраняй его на сервере.
- `LoginPupil` и `LoginTeacher` могут вернуть login-токен только как прямой успешный результат. Никогда не помещай его в логи, ошибки или кэш; публичное включение этих tools требует отдельного product/security approval.
- Тестовый ключ вводится только через локальную переменную окружения, secret manager или Postman Local Vault.
- Считай ротацию ключа штатным сценарием: после перевыпуска пользователь заменяет локальный secret без изменения общей серверной конфигурации.
- Используй очевидные placeholders, например `<EDVIBE_API_KEY>` и `<SCHOOL_HOSTNAME>`.
- Не выводи значения секретных переменных при диагностике.
- По умолчанию не логируй request/response body. Redact credentials и PII до записи любого события.
- Credential context должен быть request/session-scoped. Глобальный mutable key/domain запрещён.

## White Label и SSRF

- Никогда не пересылай API-ключ на hostname, подтверждённый только публичным DNS или TLS. Сначала проверь его по authoritative registry/allowlist Edvibe.
- Для личного пилота используй явный allowlist тестовой школы; без Edvibe-controlled registry публичная поддержка White Label заблокирована.
- Принимай только hostname без scheme, port, path, query, fragment и credentials.
- Разрешай только HTTPS/443 и фиксированный базовый путь `/school-api`.
- Не следуй redirects.
- Запрещай IP literals, localhost, loopback, link-local, private и reserved targets.
- Проверяй DNS resolution и учитывай DNS rebinding.
- Добавляй тесты на обход каждого ограничения.

## Подтверждения и внешние изменения

Перед следующими действиями остановись, покажи точную операцию и получи явное подтверждение Руслана:

1. любой live-запрос, который меняет данные, включая тестовую школу;
2. destructive или sensitive live-вызов;
3. передача репозитория или смена владельца;
4. deployment в staging/production, изменения DNS, secrets или инфраструктуры;
5. публичное включение `LoginPupil` и `LoginTeacher`: покажи recorded product/security approval и отдельно получи подтверждение Руслана.
6. публикация в Postman MCP Catalog — опциональный шаг, требует отдельного подтверждения, но не блокирует запуск.

Read-only инспекция и локальные mock-тесты разрешены без дополнительного согласования, если они не раскрывают секреты и не меняют внешнее состояние.

Не добавляй параметр `confirm=true` в MCP tools только для имитации безопасности. Подтверждение должно происходить на стороне клиента:

- Codex: в `[mcp_servers.edvibe]` используй `default_tools_approval_mode = "writes"`; для high-risk/sensitive tools — per-tool `approval_mode = "prompt"`;
- Cursor: стандартное подтверждение, auto-run выключен.

## Проверка качества

Перед заявлением о готовности обязательно проверь:

- ровно 78 операций и классификацию `35 + 24 + 17 + 2`;
- schema/collection/manifest parity;
- точную annotation-матрицу: 35 read, 24 non-destructive writes, 17 destructive и 2 sensitive; не полагайся на protocol defaults;
- mock success/error для всех 78;
- missing/invalid key и domain;
- `200 + isSuccess=false`, `401`, `403`, `429`, timeout и temporary `5xx`;
- SSRF, redirects, IP ranges и DNS rebinding;
- блокировку attacker-controlled публичного hostname до отправки заголовка `Authorization`;
- API-ключ и `errorStackTrace` отсутствуют во всех ответах; login-токены/PII отсутствуют в логах, кэше и ошибках и появляются только в разрешённом успешном результате профильной операции;
- две параллельные школы без cross-tenant leakage;
- Cursor и Codex загружают все tools, read работает, writes требуют approval;
- отсутствие автоматического retry для writes;
- health/readiness, graceful shutdown и rollback.

Валидация OpenAPI или успешный build сами по себе не доказывают runtime-готовность.

## Поддерживаемые клиенты v1

- Поддерживаются локальные Cursor и Codex.
- Cursor Cloud, Cursor auto-run и ChatGPT не входят в v1 и должны быть явно отмечены как unsupported.
- Не обещай совместимость с клиентом без end-to-end проверки.

## Документация и статус

- Всегда явно разделяй: подготовлено локально, развёрнуто на staging, развёрнуто в production. Postman-публикация — опциональный отдельный статус.
- Не называй сервер готовым до прохождения проверок и approval gates из `PLAN.md`.
- После устойчивого изменения решения обновляй `CONTEXT.md`, `PLAN.md`, `README.md` и при необходимости этот `AGENTS.md`.
- Фиксируй дату и источник изменений OpenAPI.
- Сохраняй handoff в состоянии, при котором новый агент может продолжить без истории чата и без доступа к секретам.
