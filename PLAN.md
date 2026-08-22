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
|---|---|---|
| A — Public Postman | Создание/публикация публичного workspace, API или collection | Подготовить локальные spec/collection и показать diff |
| B — Live writes | Любой запрос, меняющий live-данные, включая тестовую школу | Mock-тесты и read-only live smoke tests |
| C — Repository transfer | Передача repo в организацию Edvibe и изменение владельца | Подготовить handoff checklist |
| D — Deployment | Staging/production deploy, домены, DNS, secrets, monitoring | Собрать и локально проверить Docker image/config |
| E — Publication | Снятие `experimental/unofficial`, официальный профиль, MCP Catalog | Подготовить English listing и release candidate |
| F — Sensitive login tools | Публичное включение `LoginPupil` и `LoginTeacher` | Сохранить обе операции в 78-tool contract, но держать public tools disabled; выполнять mock и разрешённые локальные проверки |

## Этап 1. Репозиторий и контракт API

**Срок:** день 1.

### Действия

- Создать отдельный приватный Git-репозиторий `edvibe-school-mcp`.
- Скопировать в корень `README.md`, `CONTEXT.md`, `PLAN.md`, `AGENTS.md` из этого пакета.
- Скачать официальный raw OpenAPI и сохранить версионированный неизменяемый snapshot с датой и SHA-256.
- Создать overlay/script нормализации; не редактировать snapshot.
- Добавить стабильные английские `operationId` для всех 78 операций.
- Добавить manifest/inventory с HTTP-методом, path, группой и классом риска.
- Настроить CI-проверки схемы, форматирования, секретов и контрольных количеств.

### Результат

- Воспроизводимая нормализованная OpenAPI-схема.
- CI доказывает ровно 78 уникальных операций и сумму `35 + 24 + 17 + 2`.
- В репозитории нет секретов.

## Этап 2. Postman API и коллекция

**Срок:** день 2.

### Действия

- Подготовить отдельное pilot workspace; не менять видимость существующих личного или командного workspace.
- Через Postman MCP импортировать нормализованную схему и сгенерировать коллекцию.
- Разложить все 78 запросов по 14 фактическим группам API.
- Использовать только placeholders и локальные secret variables; не создавать shared current values.
- Добавить английские descriptions, examples, risk warnings и тесты `BaseResponse`.
- Сверить каждый collection request с inventory.
- Перед фактической публикацией запросить Gate A.
- До официальной передачи маркировать публичный workspace/collection как `experimental` и `unofficial`.

### Результат

- Коллекция содержит все 78 запросов без дублей и пропусков.
- Нет реальных ключей, доменов клиентов и PII.
- Коллекция готова для Public API Network и MCP Generator.

## Этап 3. Генерация личного MCP-пилота

**Срок:** день 3.

### Действия

- Открыть Postman MCP Generator вручную в авторизованной веб-сессии.
- Выбрать опубликованную pilot collection из Public API Network.
- Включить все 78 запросов.
- Сгенерировать Node.js MCP server сначала с транспортом STDIO.
- Скачать ZIP и импортировать исходники в приватный репозиторий отдельным коммитом.
- Зафиксировать версию/дату Generator и diff относительно доработанного кода.

### Результат

- Воспроизводимый baseline от Postman Generator.
- Локальный STDIO-сервер стартует без реального ключа и сообщает понятную configuration error.

> Этот шаг нельзя полностью выполнить через доступный Postman MCP: выбор запросов и скачивание ZIP выполняются в интерфейсе Generator.

## Этап 4. Усиление сервера

**Срок:** дни 4–5.

### Действия

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

### Результат

- Stateless сервер готов к mock-тестам и безопасному локальному пилоту.
- Один процесс может обслуживать разные школы без общего credential state.

## Этап 5. Личный пилот в Cursor и Codex

**Срок:** дни 6–7.

### Действия

- Сначала проверить коллекцию в Postman только с ключом из Local Vault.
- Подключить STDIO-сервер в локальном Cursor; auto-run выключить.
- Подключить STDIO-сервер в локальном Codex; в `[mcp_servers.edvibe]` задать `default_tools_approval_mode = "writes"`, а high-risk/sensitive tools — per-tool `approval_mode = "prompt"`.
- Убедиться, что оба клиента видят все 78 инструментов.
- Выполнить representative read-only smoke tests на тестовой школе.
- Проверить, что обычные writes и high-risk/sensitive инструменты требуют подтверждения.
- Live write/destructive тесты проводить только после Gate B, на disposable fixtures и с заранее записанным rollback/cleanup.
- Провести негативные и параллельные тесты из раздела [[PLAN#Обязательная программа проверок|Обязательная программа проверок]].

### Результат

- Личный пилот подтверждён отдельно для Postman, Cursor и Codex.
- Зафиксированы фактические ограничения клиента и API, а не только прохождение schema validation.

## Этап 6. Передача Edvibe и staging

**Срок:** неделя 2.

### Действия

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

### Результат

- Staging принадлежит Edvibe и проходит контрактные, security и клиентские проверки.
- Все спорные операции имеют зафиксированного product owner и публичную формулировку.

## Этап 7. Закрытая бета

**Срок:** недели 3–4.

### Аудитория

5–10 школ Edvibe/ProgressMe Pro, включая обычные Edvibe-домены и White Label.

### Действия

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

### Действия

- После Gate D развернуть production на `https://mcp.edvibe.com/mcp`.
- Провести production smoke tests только read-only операциями.
- Опубликовать англоязычные onboarding, security/privacy notes, tool catalogue, troubleshooting и status/support contacts.
- Перевести Postman workspace/collection под официальный publisher profile Edvibe и подтвердить домен.
- После Gate E убрать временные метки `experimental/unofficial`.
- После Gate F включить `LoginPupil` и `LoginTeacher`; до recorded product/security approval обе операции остаются в контракте, но выключены на public endpoint.
- Подать сервер в Postman MCP Catalog через официальный процесс Postman, включая обращение на `api-network@postman.com`.
- Подготовить rollback/kill switch для отдельных инструментов и всей версии сервера.
- Опубликовать changelog и правила версионирования несовместимых изменений.

### Результат

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

- repository, deployment и Postman publisher принадлежат Edvibe;
- all-78 contract подтверждён Edvibe и проходит CI;
- staging и production прошли security review;
- Cursor и Codex прошли end-to-end проверку;
- бета достигла численных критериев;
- документация на английском опубликована;
- секреты и PII не обнаружены;
- monitoring, support, incident response и rollback назначены конкретным владельцам;
- получены Gates A–F, включая recorded approver для двух sensitive login tools.
