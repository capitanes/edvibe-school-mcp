---
Контекст: план реализации и запуска MCP-сервера для Edvibe School API.
Тип: план проекта
Продукт: Edvibe
Рынок: international
Статус: согласовано для исполнения
Связано с:
  - "[[README|Edvibe MCP]]"
  - "[[CONTEXT|Контекст Edvibe MCP]]"
tags:
  - edvibe
  - mcp
  - api
  - rollout
created: 2026-08-22
updated: 2026-08-22
---

# План: личный пилот → закрытая бета → публичный Edvibe MCP

## Результат проекта

Официальный stateless MCP-сервер Edvibe с 78 инструментами School API, который:

- подключается в Cursor и Codex с API-ключом и доменом школы;
- корректно работает с Edvibe и White Label;
- не хранит ключи, login-токены или PII;
- требует клиентского подтверждения перед изменениями;
- защищён от SSRF, превышения лимитов и межтенантных утечек;
- размещён и поддерживается Edvibe;
- опубликован через официальный Postman workspace/profile и MCP Catalog.

## Неизменяемые условия

1. В контракте остаются все **78** операции: 35 read, 24 write, 17 high-risk, 2 sensitive.
2. Источником истины является официальный raw OpenAPI, сохранённый как snapshot; нормализация воспроизводима.
3. Реальные секреты не попадают в репозиторий, Postman shared environment, документы, логи или чат.
4. Поведение определяется семантикой операции, а не только HTTP-методом.
5. Публичные MCP-артефакты пишутся на английском.
6. Публичные изменения Postman, live-записи, deployment и публикация требуют отдельного подтверждения Руслана.
7. Личный репозиторий — временный этап; официальный сервер и production должны принадлежать Edvibe.

## Approval gates

| Gate | Что требует подтверждения | Что можно сделать до подтверждения |
| --- | --- | --- |
| B — Live writes | Любой запрос, меняющий live-данные, включая тестовую школу | Mock-тесты и read-only live smoke tests |
| C — Repository transfer | Передача repo в организацию Edvibe и изменение владельца | Подготовить handoff checklist |
| D — Deployment | Staging/production deploy, домены, DNS, secrets, monitoring | Собрать и локально проверить Docker image/config |
| F — Sensitive login tools | Публичное включение `LoginPupil` и `LoginTeacher` | Сохранить обе операции в 78-tool contract, но держать public tools disabled; выполнять mock и разрешённые локальные проверки |

### Опциональные шаги (не блокируют запуск)

| Шаг | Что даёт | Когда делать |
| --- | --- | --- |
| Postman MCP Catalog | Discoverability: школы находят сервер поиском в Cursor/Codex вместо ручного ввода URL | После запуска production, если Edvibe решит, что Catalog нужен. Onboarding через help center/инструкцию работает без Catalog. |

## Этап 1. Репозиторий и контракт API

**Срок:** день 1.

### Действия — этап 1

- Создать отдельный приватный Git-репозиторий `edvibe-school-mcp`.
- Скопировать в корень `README.md`, `CONTEXT.md`, `PLAN.md`, `AGENTS.md` из этого пакета.
- Скачать официальный raw OpenAPI и сохранить версионированный неизменяемый snapshot с датой и SHA-256.
- Создать overlay/script нормализации; не редактировать snapshot.
- Добавить стабильные английские `operationId` для всех 78 операций.
- Добавить manifest/inventory с HTTP-методом, path, группой и классом риска.
- Настроить CI-проверки схемы, форматирования, секретов и контрольных количеств.

### Результат — этап 1

- Воспроизводимая нормализованная OpenAPI-схема.
- CI доказывает ровно 78 уникальных операций и сумму `35 + 24 + 17 + 2`.
- В репозитории нет секретов.

## Этап 2. Postman Collection (генерируется локально, публикация — опциональна)

**Срок:** день 2.
**Статус:** генерация коллекции выполняется локально скриптом, Postman-аккаунт не требуется до публикации.

### Действия

- Запустить `node scripts/generate-postman-collection.cjs` — генерирует `postman/edvibe-school-api.postman_collection.json` из manifest (78 запросов, 14 групп, placeholders вместо ключей).
- Проверить parity через `node scripts/validate.cjs` — collection, manifest и normalized spec содержат одинаковые 78 операций.
- Публикация коллекции в Postman Public API Network — **опциональный шаг**, не блокирует запуск. Onboarding через help center/инструкцию работает без Catalog (см. Approval gates → опциональные шаги).

### Результат

- Коллекция сгенерирована локально, parity проверена.
- Postman-аккаунт, workspace и publisher profile не требуются до официальной публикации (Этап 8).

## Этап 3. MCP-сервер (написан вручную, Generator не используется)

**Срок:** день 3.
**Статус:** выполнен альтернативным путём — сервер написан вручную, без Postman MCP Generator.

### Почему не Generator

Изначально план предполагал генерацию кода через Postman MCP Generator из опубликованной коллекции. На практике сервер написан вручную (`src/index.js`, `src/upstream.js`, `src/tool-definitions.js`, `src/credential-context.js`), потому что:

- Generator даёт базовый boilerplate без security-слоя (SSRF, rate limit, hostname validation, BaseResponse normalization, errorStackTrace stripping, credential context);
- ручной код полностью контролируется и проходит CI-проверки `validate.cjs`;
- генерированный код потребовал бы столько же доработок, сколько написание с нуля, но с дополнительным ограничением по структуре Generator-а.

### Что фактически сделано

- `src/index.js` — STDIO MCP-сервер, 78 tool handlers, error handling.
- `src/upstream.js` — HTTP-клиент с SSRF-защитой, DNS validation, rate limiter (10 rps, 4 concurrent), BaseResponse isSuccess=false → error, errorStackTrace stripping, no redirects.
- `src/tool-definitions.js` — загрузка 78 tool definitions из manifest + normalized spec, body/query mapping, required overrides.
- `src/credential-context.js` — request/session-scoped credential context из env vars, без глобального состояния.
- Локальный STDIO-сервер стартует и работает (подтверждено live-вызовами 2026-08-22).

### Результат — этап 3

- Hand-written MCP-сервер работает локально, проходит `validate.cjs` (78 операций, 35+24+17+2).
- Postman MCP Generator не используется и не требуется для текущей архитектуры.
- Postman Collection остаётся нужна только для Public API Network (документация + listing в MCP Catalog), не для генерации кода.

## Этап 4. Усиление сервера

**Срок:** дни 4–5.

### Действия — этап 4

- Удалить глобальное хранение key/domain; внедрить request/session-scoped credential context.
- Для STDIO читать key/domain из локальной конфигурации клиента.
- Для Streamable HTTP принимать Bearer key и `X-Edvibe-School-Domain`, затем переводить авторизацию в raw upstream header.
- Реализовать строгую hostname-валидацию, HTTPS-only, запрет redirects, IP/range checks и защиту от DNS rebinding.
- До передачи `Authorization` проверять домен по Edvibe-controlled tenant registry/allowlist; для личного пилота разрешить только явный hostname тестовой школы.
- Ограничить путь upstream фиксированным `/school-api`.
- Ввести per-key rate limit 10 rps и максимум 4 concurrent requests.
- Разрешить ограниченный retry только для read-only `429`/temporary `5xx`.
- Преобразовывать `BaseResponse.isSuccess=false` в MCP error даже при HTTP 200.
- Удалять `errorStackTrace`, credentials и PII из ошибок/логов.
- Проставить annotation-матрицу по manifest: 35 read (`readOnlyHint=true`), 24 ordinary writes (`readOnlyHint=false`, `destructiveHint=false`), 17 high-risk (`readOnlyHint=false`, `destructiveHint=true`), 2 sensitive (`readOnlyHint=false`, `destructiveHint=false` + explicit warning/per-tool approval).
- Для upstream-tools задать `openWorldHint=true`; `idempotentHint` указывать только после проверки фактического поведения, иначе оставлять `false`.
- Добавить health/readiness endpoints, graceful shutdown и Docker image без root-пользователя.
- Не добавлять server-side параметр `confirm=true`; подтверждения остаются у клиента.

### Результат — этап 4

- Stateless сервер готов к mock-тестам и безопасному локальному пилоту.
- Один процесс может обслуживать разные школы без общего credential state.

## Этап 5. Личный пилот в Cursor и Codex

**Срок:** дни 6–7.

### Действия — этап 5

- Сначала проверить коллекцию в Postman только с ключом из Local Vault.
- Подключить STDIO-сервер в локальном Cursor; auto-run выключить.
- Подключить STDIO-сервер в локальном Codex; в `[mcp_servers.edvibe]` задать `default_tools_approval_mode = "writes"`, а high-risk/sensitive tools — per-tool `approval_mode = "prompt"`.
- Убедиться, что оба клиента видят все 78 инструментов.
- Выполнить representative read-only smoke tests на тестовой школе.
- Проверить, что обычные writes и high-risk/sensitive инструменты требуют подтверждения.
- Live write/destructive тесты проводить только после Gate B, на disposable fixtures и с заранее записанным rollback/cleanup.
- Провести негативные и параллельные тесты из раздела [[PLAN#Обязательная программа проверок|Обязательная программа проверок]].

### Личный HTTP-стенд Руслана (вне официального staging/production)

Параллельно с локальным STDIO-пилотом поднимается личный HTTP-стенд Руслана на `https://edvibe.sungurov.com/mcp` для удалённого тестирования через интернет. Это **не** staging/production из официального плана (Gate D не затрагивается, потому что это не `mcp-staging.edvibe.com` / `mcp.edvibe.com`, не принадлежит Edvibe).

Параметры стенда:

- поддомен `edvibe.sungurov.com`, A-запись → `185.180.230.233`;
- Nginx Proxy Manager: Proxy Host `edvibe.sungurov.com` → `host.docker.internal:9000`, SSL Let's Encrypt, Force SSL, Websockets Support;
- сервер `185.180.230.233`, путь на диске `/var/www/edvibe.sungurov.com/edvibe-school-mcp/`;
- MCP-сервер запускается как systemd-сервис `edvibe-mcp.service` на порту 9000, от имени непривилегированного пользователя;
- авторизация доступа — вариант A (см. `CONTEXT.md` → «Авторизация доступа к HTTP-endpoint»): без отдельного access-токена, единственный ключ — `EDVIBE_API_KEY`, который клиент передаёт в `Authorization: Bearer <key>`; MCP-сервер снимает `Bearer ` и использует его же для upstream-вызова к Edvibe;
- `X-Edvibe-School-Domain: <hostname>` передаётся клиентом в каждом запросе — без него сервер не знает, к какому домену школы обращаться upstream;
- `/healthz` endpoint для проверок NPM/systemd (не раскрывает конфигурацию);
- секреты не хранятся на сервере: ни в `.env`, ни в systemd unit, ни в коде. Ключ и домен приходят в каждом запросе от клиента.

Стенд используется только для личного пилота Руслана и не публикуется. После официальной передачи Edvibe (Gate C/D) стенд сворачивается или заменяется на `mcp-staging.edvibe.com`.

### Результат — этап 5

- Личный пилот подтверждён отдельно для Postman, Cursor и Codex.
- Зафиксированы фактические ограничения клиента и API, а не только прохождение schema validation.

## Этап 6. Передача Edvibe и staging

**Срок:** неделя 2.

### Действия — этап 6

- Провести review с product/engineering и подтвердить поддержку всех 78 операций.
- Разрешить конфликты Swagger/help center с Димой/Полиной.
- Согласовать владельца, лицензию, security policy, support/incident response и SLA.
- После Gate C передать репозиторий официальной организации Edvibe.
- Перенести CI, secret management и package/container registry под Edvibe.
- После Gate D развернуть staging на `https://mcp-staging.edvibe.com/mcp`.
- Настроить метрики без body/PII: uptime, latency, error class, throttling и tool identifier.
- Провести security review White Label routing, SSRF, key isolation и логирования.
- Получить от Edvibe authoritative registry/resolver обычных и White Label доменов; без него staging/public multi-tenant rollout заблокирован.
- Отдельно согласовать public enablement `LoginPupil`/`LoginTeacher` и риск сохранения login-токена в истории MCP-клиента.

### Результат — этап 6

- Staging принадлежит Edvibe и проходит контрактные, security и клиентские проверки.
- Все спорные операции имеют зафиксированного product owner и публичную формулировку.

## Этап 7. Закрытая бета

**Срок:** недели 3–4.

### Аудитория

5–10 школ Edvibe/ProgressMe Pro, включая обычные Edvibe-домены и White Label.

### Действия — этап 7

- Дать короткую английскую инструкцию подключения для Cursor и Codex.
- Предупредить, что ключ может показываться только при создании, а его перевыпуск требует заменить локальный secret без переустановки MCP.
- Не собирать API-ключи централизованно: школа вводит ключ только в свой клиент.
- Проверить сценарии чтения, безопасных изменений и понятность approval prompts.
- Собирать только минимальную обезличенную диагностику и качественную обратную связь.
- Отдельно отслеживать время подключения, успешность сценариев, 401/403/429, ошибки domain validation и случаи непонятного риска.

### Критерии выхода

- не менее 8 из 10 школ подключаются за 10 минут или быстрее;
- не менее 90% согласованных ключевых сценариев завершаются успешно;
- ноль утечек секретов/PII;
- ноль межтенантных утечек;
- ноль подтверждённых SSRF-инцидентов;
- все high-risk операции дают понятное подтверждение в поддерживаемых клиентах;
- критические ошибки имеют исправление и regression test.

Если критерии не выполнены, public launch откладывается; размер инструментария не сокращается молча, а решение согласуется с Edvibe.

## Этап 8. Публичный запуск

### Действия — этап 8

- После Gate D развернуть production на `https://mcp.edvibe.com/mcp`.
- Провести production smoke tests только read-only операциями.
- Опубликовать англоязычные onboarding, security/privacy notes, tool catalogue, troubleshooting и status/support contacts.
- После Gate F включить `LoginPupil` и `LoginTeacher`; до recorded product/security approval обе операции остаются в контракте, но выключены на public endpoint.
- Подготовить rollback/kill switch для отдельных инструментов и всей версии сервера.
- Опубликовать changelog и правила версионирования несовместимых изменений.
- **Опционально:** если Edvibe решит, что Postman MCP Catalog нужен для discoverability — перевести Postman workspace/collection под официальный publisher profile Edvibe, подтвердить домен и подать сервер в Catalog через `api-network@postman.com`. Onboarding через help center/инструкцию работает без этого шага.

### Результат — этап 8

- Официальный публичный Edvibe MCP доступен по Edvibe-домену и сопровождается командой Edvibe.
- В v1 onboarding явно указан Pro/API-enabled scope; расширение на остальные тарифы зависит от отдельного решения Edvibe о доступности School API.

## Обязательная программа проверок

### Контракт и генерация

- Ровно 78 уникальных method/path и 78 уникальных `operationId`.
- Ровно 35 read, 24 write, 17 high-risk, 2 sensitive.
- Annotation manifest явно задаёт `readOnlyHint` и `destructiveHint`; отсутствие поля не используется как классификация.
- Все операции из исходного snapshot присутствуют в normalized spec, Postman collection и MCP tool manifest.
- Генерируемые артефакты воспроизводятся без ручной правки результата.

### Mock upstream

- Успешный и ошибочный ответ для каждой из 78 операций.
- `HTTP 200` + `isSuccess=false` становится MCP error.
- `errorStackTrace` не попадает клиенту.
- Проверены преобразования dotted-параметров и request body.

### Live API

- Representative read-only endpoints из каждой релевантной группы.
- Никаких live writes без Gate B.
- Writes/high-risk после подтверждения используют disposable fixtures и проверяемый cleanup.

### Негативные сценарии

- отсутствующий и неверный API-ключ;
- отсутствующий, неверный или неподдерживаемый домен;
- scheme/path/port в поле домена;
- IP literal, localhost, private/reserved DNS target и DNS rebinding;
- публичный hostname злоумышленника с валидным DNS/TLS: запрос блокируется до отправки `Authorization`;
- `401`, `403`, `429`, timeout и temporary `5xx`;
- ротация ключа без перезапуска общего сервиса;
- отсутствие автоматического retry для writes;
- безопасная ошибка при некорректной оболочке `BaseResponse`.

### Секреты, PII и изоляция

- Secret scan Git history, fixtures, snapshots, logs и Postman artifacts.
- API-ключ, login-токен, cookies, request/response body и PII не появляются в логах.
- Две параллельные сессии разных школ не смешивают домен, ключ, rate limit или ответы.
- После завершения запроса credential context освобождается.

### Клиенты

- Cursor локально загружает все 78 tools, выполняет read и просит approval для writes; auto-run выключен.
- Codex локально загружает все 78 tools, выполняет read и использует approval mode для writes/high-risk.
- Unsupported в v1 явно задокументированы: Cursor Cloud, auto-run и ChatGPT.

### Эксплуатация

- Health/readiness не раскрывают конфигурацию.
- Graceful shutdown не обрывает незавершённые запросы неконтролируемо.
- Метрики не содержат key/domain/PII.
- Проверены rollback, отключение отдельного tool и откат версии контейнера.

## Definition of done публичной версии

Публичная версия считается готовой только когда одновременно выполнено следующее:

- repository и deployment принадлежат Edvibe;
- all-78 contract подтверждён Edvibe и проходит CI;
- staging и production прошли security review;
- Cursor и Codex прошли end-to-end проверку;
- бета достигла численных критериев;
- документация на английском опубликована;
- секреты и PII не обнаружены;
- monitoring, support, incident response и rollback назначены конкретным владельцам;
- получены Gates B–D и F, включая recorded approver для двух sensitive login tools.
- Postman MCP Catalog — опционально, по решению Edvibe.
