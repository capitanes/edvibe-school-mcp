(function () {
  "use strict";

  var API_BASE = "/admin/analytics/api";
  var TIME_ZONE = "Europe/Moscow";
  var EVENT_PAGE_SIZE = 50;
  var VALID_RANGES = new Set(["24h", "7d", "30d", "90d", "365d"]);
  var FILTER_NAMES = [
    "tenant_id",
    "installation_id",
    "client_family",
    "tool_group",
    "outcome",
  ];

  var dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  var dayFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "short",
  });

  var hourFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });

  var elements = {
    form: byId("filters-form"),
    range: byId("range-filter"),
    tenant: byId("tenant-filter"),
    installation: byId("installation-filter"),
    client: byId("client-filter"),
    group: byId("group-filter"),
    outcome: byId("outcome-filter"),
    groupOptions: byId("tool-groups"),
    activeFilters: byId("active-filters"),
    reset: byId("reset-filters"),
    refresh: byId("refresh-button"),
    updatedAt: byId("updated-at"),
    notice: byId("notice"),
    metrics: byId("metric-grid"),
    activityWindows: byId("activity-windows-table"),
    operations: byId("operations-grid"),
    activity: byId("activity-chart"),
    heatmap: byId("usage-heatmap"),
    tools: byId("tools-table"),
    groups: byId("groups-list"),
    errors: byId("errors-list"),
    scenarios: byId("scenarios-list"),
    clients: byId("clients-table"),
    events: byId("events-table"),
    eventsCount: byId("events-count"),
    loadMore: byId("load-more"),
  };

  var state = {
    filters: {
      range: "30d",
      tenant_id: "",
      installation_id: "",
      client_family: "",
      tool_group: "",
      outcome: "",
    },
    loadId: 0,
    controller: null,
    eventsCursor: null,
    eventCount: 0,
    eventsLoading: false,
    lastDashboard: null,
  };

  var metricDefinitions = [
    {
      key: "activeTenants",
      label: "Активные школы",
      note: "С успешным вызовом School API",
      format: formatInteger,
    },
    {
      key: "activeInstallations",
      label: "Активные установки",
      note: "Только с валидным UUID",
      format: formatInteger,
    },
    {
      key: "initializationCount",
      label: "Инициализации",
      note: "Принятые initialize-запросы",
      format: formatInteger,
    },
    {
      key: "toolCalls",
      label: "Вызовы инструментов",
      note: "Все завершённые tool calls",
      format: formatInteger,
    },
    {
      key: "successRate",
      label: "Успешность",
      note: "Доля успешных вызовов",
      format: formatPercent,
    },
    {
      key: "p50Ms",
      label: "Медианная задержка",
      note: "p50 полного вызова",
      format: formatDuration,
    },
    {
      key: "p95Ms",
      label: "Задержка p95",
      note: "95% вызовов быстрее",
      format: formatDuration,
    },
    {
      key: "installationCoverage",
      label: "Покрытие установок",
      note: "Доля вызовов с client ID",
      format: formatPercent,
    },
  ];

  var eventLabels = {
    service_started: "Сервис запущен",
    mcp_initialize_completed: "MCP инициализирован",
    mcp_request_rejected: "Запрос отклонён",
    tool_call_completed: "Вызов завершён",
    service_stopped: "Сервис остановлен",
    telemetry_storage_degraded: "Сбой хранилища",
  };

  initialise();

  function initialise() {
    applyFiltersFromUrl();
    bindEvents();
    renderDashboard({});
    renderEvents([], false);
    loadAll();
  }

  function bindEvents() {
    elements.form.addEventListener("submit", function (event) {
      event.preventDefault();
      state.filters = readFilters();
      updateUrl();
      renderActiveFilters();
      loadAll();
    });

    elements.reset.addEventListener("click", function () {
      elements.range.value = "30d";
      elements.tenant.value = "";
      elements.installation.value = "";
      elements.client.value = "";
      elements.group.value = "";
      elements.outcome.value = "";
      state.filters = readFilters();
      updateUrl();
      renderActiveFilters();
      loadAll();
    });

    elements.refresh.addEventListener("click", function () {
      loadAll();
    });

    elements.loadMore.addEventListener("click", function () {
      loadMoreEvents();
    });
  }

  function applyFiltersFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var requestedRange = params.get("range");
    if (VALID_RANGES.has(requestedRange)) {
      elements.range.value = requestedRange;
    }

    setInputValue(elements.tenant, params.get("tenant_id"), 128);
    setInputValue(elements.installation, params.get("installation_id"), 128);
    setSelectValue(elements.client, params.get("client_family"), 64);
    setInputValue(elements.group, params.get("tool_group"), 80);
    setSelectValue(elements.outcome, params.get("outcome"), 32);

    state.filters = readFilters();
    renderActiveFilters();
  }

  function setInputValue(input, value, maxLength) {
    if (!value) return;
    input.value = String(value).slice(0, maxLength);
  }

  function setSelectValue(select, value, maxLength) {
    if (!value) return;
    var safeValue = String(value).slice(0, maxLength);
    var hasOption = Array.from(select.options).some(function (option) {
      return option.value === safeValue;
    });
    if (!hasOption) {
      var option = document.createElement("option");
      option.value = safeValue;
      option.textContent = safeValue;
      select.appendChild(option);
    }
    select.value = safeValue;
  }

  function readFilters() {
    var range = elements.range.value;
    var tenant = trimValue(elements.tenant.value, 128);
    var installation = trimValue(elements.installation.value, 128);
    if (range === "365d" && (tenant || installation)) {
      range = "90d";
      elements.range.value = "90d";
    }
    return {
      range: VALID_RANGES.has(range) ? range : "30d",
      tenant_id: tenant,
      installation_id: installation,
      client_family: trimValue(elements.client.value, 64),
      tool_group: trimValue(elements.group.value, 80),
      outcome: trimValue(elements.outcome.value, 32),
    };
  }

  function updateUrl() {
    var params = buildParams();
    var query = params.toString();
    var nextUrl = window.location.pathname + (query ? "?" + query : "");
    window.history.replaceState(null, "", nextUrl);
  }

  function buildParams(cursor) {
    var params = new URLSearchParams();
    params.set("range", state.filters.range);
    FILTER_NAMES.forEach(function (name) {
      if (state.filters[name]) {
        params.set(name, state.filters[name]);
      }
    });
    if (cursor) {
      params.set("cursor", String(cursor).slice(0, 1024));
    }
    return params;
  }

  async function loadAll() {
    state.loadId += 1;
    var loadId = state.loadId;
    if (state.controller) {
      state.controller.abort();
    }
    state.controller = new AbortController();
    setBusy(true);
    setNotice("Загружаем безопасную телеметрию…", "");

    var dashboardParams = buildParams();
    var eventsParams = buildParams();
    eventsParams.set("limit", String(EVENT_PAGE_SIZE));

    try {
      var results = await Promise.allSettled([
        fetchJson("dashboard", dashboardParams, state.controller.signal),
        fetchJson("events", eventsParams, state.controller.signal),
      ]);

      if (loadId !== state.loadId) return;

      var problems = [];
      if (results[0].status === "fulfilled") {
        var dashboard = unwrapPayload(results[0].value);
        state.lastDashboard = dashboard;
        renderDashboard(dashboard);
        updateTimestamp(dashboard);
      } else if (!isAbortError(results[0].reason)) {
        problems.push(messageFromError(results[0].reason, "Не удалось загрузить сводку."));
      }

      if (results[1].status === "fulfilled") {
        var eventsPayload = unwrapPayload(results[1].value);
        var items = Array.isArray(eventsPayload.items) ? eventsPayload.items : [];
        state.eventsCursor = safeCursor(eventsPayload.nextCursor);
        state.eventCount = items.length;
        renderEvents(items, false);
        updateLoadMore();
      } else if (!isAbortError(results[1].reason)) {
        problems.push(messageFromError(results[1].reason, "Не удалось загрузить события."));
      }

      if (problems.length) {
        setNotice(problems.join(" "), "error");
      } else {
        showOperationalNotice(state.lastDashboard);
      }
    } finally {
      if (loadId === state.loadId) {
        setBusy(false);
      }
    }
  }

  async function loadMoreEvents() {
    if (!state.eventsCursor || state.eventsLoading) return;
    state.eventsLoading = true;
    elements.loadMore.disabled = true;
    elements.loadMore.textContent = "Загружаем…";

    var params = buildParams(state.eventsCursor);
    params.set("limit", String(EVENT_PAGE_SIZE));

    try {
      var payload = unwrapPayload(await fetchJson("events", params));
      var items = Array.isArray(payload.items) ? payload.items : [];
      state.eventsCursor = safeCursor(payload.nextCursor);
      state.eventCount += items.length;
      renderEvents(items, true);
      updateLoadMore();
    } catch (error) {
      setNotice(messageFromError(error, "Не удалось загрузить следующую страницу событий."), "error");
    } finally {
      state.eventsLoading = false;
      elements.loadMore.disabled = false;
      elements.loadMore.textContent = "Показать ещё";
    }
  }

  async function fetchJson(endpoint, params, signal) {
    var url = API_BASE + "/" + endpoint + "?" + params.toString();
    var response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: signal,
    });

    if (response.status === 401) {
      throw new Error("Требуется повторная авторизация для доступа к аналитике.");
    }
    if (!response.ok) {
      throw new Error("Сервер аналитики вернул ошибку " + response.status + ".");
    }

    try {
      return await response.json();
    } catch (_error) {
      throw new Error("Сервер аналитики вернул некорректный JSON.");
    }
  }

  function renderDashboard(dashboard) {
    var summary = objectValue(dashboard.summary) || objectValue(dashboard.cards) || dashboard;
    var operational = objectValue(dashboard.operational) || objectValue(dashboard.storage) || dashboard;

    renderMetrics(summary);
    renderActivityWindows(objectValue(dashboard.activityWindows) || {});
    renderOperations(operational);
    renderActivity(arrayValue(dashboard.activity));
    renderHeatmap(arrayValue(dashboard.heatmap));
    renderTools(arrayValue(dashboard.tools));
    renderGroups(arrayValue(dashboard.groups));
    renderErrors(arrayValue(dashboard.errors));
    renderScenarios(arrayValue(dashboard.scenarios));
    renderClients(arrayValue(dashboard.clients));
  }

  function renderMetrics(summary) {
    elements.metrics.replaceChildren();
    metricDefinitions.forEach(function (definition) {
      var card = createElement("article", "metric-card");
      var label = createElement("p", "metric-card__label", definition.label);
      var value = createElement(
        "p",
        "metric-card__value",
        definition.format(valueOf(summary, [definition.key]))
      );
      var note = createElement("p", "metric-card__note", definition.note);
      card.append(label, value, note);
      elements.metrics.appendChild(card);
    });
  }

  function renderActivityWindows(windows) {
    elements.activityWindows.replaceChildren();
    [
      ["24h", "24 часа"],
      ["7d", "7 дней"],
      ["30d", "30 дней"],
      ["90d", "90 дней"],
    ].forEach(function (definition) {
      var item = objectValue(windows[definition[0]]) || {};
      var row = document.createElement("tr");
      row.append(
        createCell(definition[1]),
        numericCell(formatInteger(valueOf(item, ["activeTenants"]))),
        numericCell(formatInteger(valueOf(item, ["activeInstallations"]))),
        numericCell(formatInteger(valueOf(item, ["toolCalls", "calls"]))),
        numericCell(formatInteger(valueOf(item, ["activeDays"])))
      );
      elements.activityWindows.appendChild(row);
    });
  }

  function renderOperations(operational) {
    elements.operations.replaceChildren();
    var status = safeText(
      valueOf(operational, ["storageStatus", "status"]),
      40
    ).toLowerCase();
    var dropped = valueOf(operational, ["droppedEvents", "dropped"]);
    var dbSize = valueOf(operational, ["dbSizeBytes", "databaseSizeBytes"]);
    var lastEvent = valueOf(operational, ["lastEventAt", "latestEventAt"]);

    var statusInfo = storageStatus(status);
    var statusValue = createElement(
      "span",
      "status-pill status-pill--" + statusInfo.tone,
      statusInfo.label
    );
    appendOperationItem("Хранилище", statusValue);
    appendOperationItem("Потеряно событий", createElement("span", "", formatInteger(dropped)));
    appendOperationItem("Размер базы", createElement("span", "", formatBytes(dbSize)));
    appendOperationItem("Последнее событие", createElement("span", "", formatDateTime(lastEvent)));
  }

  function appendOperationItem(label, valueNode) {
    var wrapper = createElement("dl", "operation-item");
    wrapper.append(createElement("dt", "", label));
    var value = createElement("dd");
    value.appendChild(valueNode);
    wrapper.appendChild(value);
    elements.operations.appendChild(wrapper);
  }

  function renderActivity(items) {
    elements.activity.replaceChildren();
    if (!items.length) {
      elements.activity.appendChild(emptyState("За выбранный период вызовов нет."));
      return;
    }

    var width = 1120;
    var height = 210;
    var chartTop = 8;
    var chartBottom = 174;
    var plotHeight = chartBottom - chartTop;
    var maxCalls = Math.max.apply(
      null,
      items.map(function (item) {
        return numericValue(valueOf(item, ["toolCalls", "calls", "count"]));
      }).concat([1])
    );

    var svg = createSvgElement("svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(height));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Динамика вызовов инструментов");
    svg.setAttribute("preserveAspectRatio", "none");

    [0.25, 0.5, 0.75, 1].forEach(function (portion) {
      var line = createSvgElement("line");
      var y = chartBottom - plotHeight * portion;
      line.setAttribute("x1", "18");
      line.setAttribute("x2", String(width - 10));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", "#eeeaf0");
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);
    });

    var slot = (width - 32) / items.length;
    var barWidth = Math.max(2, Math.min(24, slot * 0.7));
    var labelStride = Math.max(1, Math.ceil(items.length / 9));

    items.forEach(function (item, index) {
      var calls = numericValue(valueOf(item, ["toolCalls", "calls", "count"]));
      var successful = numericValue(
        valueOf(item, ["successfulCalls", "successCalls", "success"])
      );
      if (!successful) {
        var successRate = normalisePercent(valueOf(item, ["successRate"]));
        successful = calls * successRate;
      }

      var x = 20 + index * slot + (slot - barWidth) / 2;
      var callsHeight = calls > 0 ? Math.max(2, (calls / maxCalls) * plotHeight) : 0;
      var successHeight = calls > 0
        ? Math.max(0, Math.min(callsHeight, (successful / maxCalls) * plotHeight))
        : 0;
      var bucket = valueOf(item, ["bucket", "timestamp", "date", "time", "label"]);

      var totalRect = createSvgElement("rect");
      totalRect.setAttribute("x", String(x));
      totalRect.setAttribute("y", String(chartBottom - callsHeight));
      totalRect.setAttribute("width", String(barWidth));
      totalRect.setAttribute("height", String(callsHeight));
      totalRect.setAttribute("rx", "3");
      totalRect.setAttribute("fill", "#6849d8");
      totalRect.setAttribute("opacity", "0.9");

      var title = createSvgElement("title");
      title.textContent =
        formatBucketTitle(bucket) +
        ": " +
        formatInteger(calls) +
        " вызовов, " +
        formatInteger(successful) +
        " успешных";
      totalRect.appendChild(title);
      svg.appendChild(totalRect);

      if (successHeight > 0) {
        var successRect = createSvgElement("rect");
        successRect.setAttribute("x", String(x));
        successRect.setAttribute("y", String(chartBottom - successHeight));
        successRect.setAttribute("width", String(barWidth));
        successRect.setAttribute("height", String(successHeight));
        successRect.setAttribute("rx", "3");
        successRect.setAttribute("fill", "#69c199");
        successRect.setAttribute("opacity", "0.82");
        svg.appendChild(successRect);
      }

      if (index % labelStride === 0 || index === items.length - 1) {
        var text = createSvgElement("text");
        text.setAttribute("x", String(x + barWidth / 2));
        text.setAttribute("y", "199");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("fill", "#8c8594");
        text.setAttribute("font-size", "10");
        text.textContent = formatBucketLabel(bucket);
        svg.appendChild(text);
      }
    });

    elements.activity.appendChild(svg);
  }

  function renderHeatmap(items) {
    elements.heatmap.replaceChildren();
    var values = new Map();
    var max = 0;

    items.forEach(function (item) {
      var day = normaliseWeekday(
        valueOf(item, ["weekday", "isoDay", "dayOfWeek", "day"])
      );
      var hour = Math.trunc(numericValue(valueOf(item, ["hour", "hourOfDay"])));
      var count = numericValue(valueOf(item, ["toolCalls", "calls", "count"]));
      if (day < 0 || day > 6 || hour < 0 || hour > 23) return;
      values.set(day + ":" + hour, count);
      max = Math.max(max, count);
    });

    elements.heatmap.appendChild(createElement("span", "heatmap__corner", "МСК"));
    for (var hour = 0; hour < 24; hour += 1) {
      elements.heatmap.appendChild(
        createElement("span", "heatmap__hour", hour % 3 === 0 ? padTwo(hour) : "")
      );
    }

    ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach(function (dayName, dayIndex) {
      elements.heatmap.appendChild(createElement("span", "heatmap__day", dayName));
      for (var hour = 0; hour < 24; hour += 1) {
        var count = values.get(dayIndex + ":" + hour) || 0;
        var cell = createElement("span", "heatmap__cell");
        var level = count > 0 && max > 0 ? Math.max(1, Math.ceil((count / max) * 4)) : 0;
        cell.dataset.level = String(level);
        cell.title =
          dayName + ", " + padTwo(hour) + ":00 — " + formatInteger(count) + " вызовов";
        cell.setAttribute("aria-label", cell.title);
        elements.heatmap.appendChild(cell);
      }
    });
  }

  function renderTools(items) {
    elements.tools.replaceChildren();
    if (!items.length) {
      appendEmptyTableRow(elements.tools, 5, "Нет вызовов инструментов.");
      return;
    }

    items.slice(0, 25).forEach(function (item) {
      var row = document.createElement("tr");
      var name = safeText(valueOf(item, ["name", "toolName", "tool"]), 140);
      var group = safeText(valueOf(item, ["group", "toolGroup"]), 80);
      var risk = safeText(valueOf(item, ["risk", "riskClass"]), 40).toLowerCase();

      var nameCell = document.createElement("td");
      var nameWrapper = createElement("div", "tool-name");
      nameWrapper.appendChild(createElement("strong", "mono", name || "—"));
      if (risk) {
        nameWrapper.appendChild(
          createElement(
            "span",
            "risk-badge risk-badge--" + riskClassName(risk),
            riskLabel(risk)
          )
        );
      }
      nameCell.appendChild(nameWrapper);

      var groupCell = document.createElement("td");
      if (group) {
        groupCell.appendChild(makeFilterButton(group, "tool_group"));
      } else {
        groupCell.textContent = "—";
      }

      row.append(
        nameCell,
        groupCell,
        numericCell(formatInteger(valueOf(item, ["calls", "toolCalls", "count"]))),
        numericCell(formatPercent(valueOf(item, ["successRate"]))),
        numericCell(formatDuration(valueOf(item, ["averageDurationMs", "p95Ms", "latencyP95Ms"])))
      );
      elements.tools.appendChild(row);
    });
  }

  function renderGroups(items) {
    renderRankList(elements.groups, items, {
      nameKeys: ["name", "group", "toolGroup"],
      valueKeys: ["calls", "toolCalls", "count"],
      empty: "Нет данных по группам.",
      filterName: "tool_group",
    });
    updateGroupOptions(items);
  }

  function renderErrors(items) {
    renderRankList(elements.errors, items, {
      nameKeys: ["code", "errorCode", "name"],
      valueKeys: ["count", "errors"],
      empty: "Ошибок за выбранный период нет.",
      error: true,
    });
  }

  function renderRankList(container, items, options) {
    container.replaceChildren();
    if (!items.length) {
      container.appendChild(emptyState(options.empty));
      return;
    }

    var max = Math.max.apply(
      null,
      items.map(function (item) {
        return numericValue(valueOf(item, options.valueKeys));
      }).concat([1])
    );

    items.slice(0, 12).forEach(function (item) {
      var name = safeText(valueOf(item, options.nameKeys), 120) || "Не определено";
      var count = numericValue(valueOf(item, options.valueKeys));
      var wrapper = createElement("div", "rank-item");
      var head = createElement("div", "rank-item__head");
      var nameNode = options.filterName
        ? makeFilterButton(name, options.filterName)
        : createElement("span", "rank-item__name mono", name);
      if (options.filterName) nameNode.classList.add("rank-item__name");
      head.append(
        nameNode,
        createElement("span", "rank-item__value", formatInteger(count))
      );

      var track = createElement("div", "rank-item__track");
      var svg = createSvgElement("svg");
      svg.setAttribute("viewBox", "0 0 100 7");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "7");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      var bar = createSvgElement("rect");
      bar.setAttribute("x", "0");
      bar.setAttribute("y", "0");
      bar.setAttribute("width", String(Math.max(count > 0 ? 1 : 0, (count / max) * 100)));
      bar.setAttribute("height", "7");
      bar.setAttribute("rx", "3.5");
      bar.setAttribute("fill", options.error ? "#c44a59" : "#6849d8");
      svg.appendChild(bar);
      track.appendChild(svg);
      wrapper.append(head, track);
      container.appendChild(wrapper);
    });
  }

  function renderScenarios(items) {
    elements.scenarios.replaceChildren();
    if (!items.length) {
      elements.scenarios.appendChild(emptyState("Недостаточно цепочек с валидным client ID."));
      return;
    }

    items.slice(0, 10).forEach(function (item) {
      var sequenceValue = valueOf(item, ["tools", "sequence", "toolSequence"]);
      var sequence = Array.isArray(sequenceValue)
        ? sequenceValue.map(function (tool) { return safeText(tool, 80); }).filter(Boolean)
        : safeText(sequenceValue, 280)
            .split(/\s*(?:→|>|,)\s*/)
            .filter(Boolean);
      var row = createElement("li", "scenario-item");
      row.append(
        createElement(
          "span",
          "scenario-item__sequence",
          sequence.length ? sequence.join(" → ") : "Не определено"
        ),
        createElement(
          "span",
          "scenario-item__count",
          formatInteger(valueOf(item, ["count", "sessions"])) + " сесс."
        )
      );
      elements.scenarios.appendChild(row);
    });
  }

  function renderClients(items) {
    elements.clients.replaceChildren();
    if (!items.length) {
      appendEmptyTableRow(elements.clients, 5, "Нет данных о MCP-клиентах.");
      return;
    }

    items.slice(0, 25).forEach(function (item) {
      var row = document.createElement("tr");
      var family = safeText(valueOf(item, ["family", "clientFamily", "name"]), 64);
      var familyCell = document.createElement("td");
      familyCell.appendChild(
        family ? makeFilterButton(family, "client_family") : document.createTextNode("—")
      );
      row.append(
        familyCell,
        createCell(safeText(valueOf(item, ["version", "clientVersion"]), 64) || "—", "mono"),
        numericCell(formatInteger(valueOf(item, ["installations", "activeInstallations"]))),
        numericCell(formatInteger(valueOf(item, ["calls", "toolCalls", "count"]))),
        numericCell(formatPercent(valueOf(item, ["successRate"])))
      );
      elements.clients.appendChild(row);
    });
  }

  function renderEvents(items, append) {
    if (!append) {
      elements.events.replaceChildren();
    }

    if (!items.length && !append && state.eventCount === 0) {
      appendEmptyTableRow(elements.events, 8, "Безопасных событий за выбранный период нет.");
      elements.eventsCount.textContent = "Нет событий";
      return;
    }

    if (append) {
      var emptyRow = elements.events.querySelector(".empty-state--table");
      if (emptyRow) emptyRow.remove();
    }

    items.forEach(function (item) {
      var row = document.createElement("tr");
      var tenant = safeText(valueOf(item, ["tenantId", "tenant_id"]), 128);
      var installation = safeText(
        valueOf(item, ["installationId", "installation_id"]),
        128
      );
      var clientFamily = safeText(
        valueOf(item, ["clientFamily", "client_family"]),
        64
      );
      var clientVersion = safeText(
        valueOf(item, ["clientVersion", "client_version"]),
        64
      );
      var tool = safeText(valueOf(item, ["toolName", "tool_name", "tool"]), 140);
      var method = safeText(valueOf(item, ["mcpMethod", "mcp_method"]), 80);
      var eventType = safeText(valueOf(item, ["eventType", "event_type", "type"]), 80);
      var outcome = safeText(valueOf(item, ["outcome"]), 40).toLowerCase();
      var errorCode = safeText(valueOf(item, ["errorCode", "error_code"]), 100);

      row.appendChild(createCell(formatDateTime(valueOf(item, ["timestamp", "occurredAt", "createdAt", "time"])), "mono"));
      row.appendChild(createCell(eventLabels[eventType] || eventType || "—", ""));
      row.appendChild(filterCell(tenant, "tenant_id"));
      row.appendChild(filterCell(installation, "installation_id"));
      row.appendChild(
        createCell(
          joinParts([clientFamily || "Не определён", clientVersion], " · "),
          ""
        )
      );
      row.appendChild(createCell(tool || method || "—", "mono"));

      var outcomeCell = document.createElement("td");
      outcomeCell.appendChild(
        createElement(
          "span",
          "outcome-badge outcome-badge--" + outcomeClass(outcome),
          outcomeLabel(outcome)
        )
      );
      if (errorCode) {
        outcomeCell.appendChild(createElement("div", "mono muted", errorCode));
      }
      row.appendChild(outcomeCell);
      row.appendChild(
        numericCell(formatDuration(valueOf(item, ["durationMs", "duration_ms", "latencyMs"])))
      );
      elements.events.appendChild(row);
    });

    elements.eventsCount.textContent =
      "Показано " + formatInteger(state.eventCount) + " событий";
  }

  function filterCell(value, filterName) {
    var cell = document.createElement("td");
    if (!value) {
      cell.textContent = "—";
      cell.className = "muted";
      return cell;
    }
    cell.appendChild(makeFilterButton(value, filterName));
    return cell;
  }

  function makeFilterButton(value, filterName) {
    var button = createElement("button", "link-button mono", value);
    button.type = "button";
    button.title = "Отфильтровать по значению " + value;
    button.addEventListener("click", function () {
      applyDrillDown(filterName, value);
    });
    return button;
  }

  function applyDrillDown(filterName, value) {
    if (filterName === "tenant_id") {
      elements.tenant.value = value;
    } else if (filterName === "installation_id") {
      elements.installation.value = value;
    } else if (filterName === "client_family") {
      setSelectValue(elements.client, value.toLowerCase(), 64);
    } else if (filterName === "tool_group") {
      elements.group.value = value;
    } else if (filterName === "outcome") {
      setSelectValue(elements.outcome, value.toLowerCase(), 32);
    } else {
      return;
    }

    state.filters = readFilters();
    updateUrl();
    renderActiveFilters();
    loadAll();
  }

  function renderActiveFilters() {
    elements.activeFilters.replaceChildren();
    var labels = {
      range: "Период",
      tenant_id: "Школа",
      installation_id: "Установка",
      client_family: "Клиент",
      tool_group: "Группа",
      outcome: "Результат",
    };
    Object.keys(labels).forEach(function (name) {
      var value = state.filters[name];
      if (!value) return;
      elements.activeFilters.appendChild(
        createElement("span", "filter-chip", labels[name] + ": " + value)
      );
    });
  }

  function updateGroupOptions(items) {
    elements.groupOptions.replaceChildren();
    var groups = new Set();
    items.forEach(function (item) {
      var group = safeText(valueOf(item, ["name", "group", "toolGroup"]), 80);
      if (group) groups.add(group);
    });
    Array.from(groups).sort().forEach(function (group) {
      var option = document.createElement("option");
      option.value = group;
      elements.groupOptions.appendChild(option);
    });
  }

  function updateLoadMore() {
    elements.loadMore.hidden = !state.eventsCursor;
    elements.eventsCount.textContent =
      state.eventCount > 0
        ? "Показано " + formatInteger(state.eventCount) + " событий"
        : "Нет событий";
  }

  function updateTimestamp(dashboard) {
    var timestamp = valueOf(dashboard, ["generatedAt", "generated_at"]);
    if (!timestamp) {
      var operational = objectValue(dashboard.operational);
      timestamp = operational && valueOf(operational, ["lastEventAt", "latestEventAt"]);
    }
    elements.updatedAt.textContent = timestamp
      ? "Обновлено: " + formatDateTime(timestamp)
      : "Обновлено сейчас";
  }

  function showOperationalNotice(dashboard) {
    if (!dashboard) {
      hideNotice();
      return;
    }
    var operational = objectValue(dashboard.operational) || objectValue(dashboard.storage) || dashboard;
    var status = safeText(valueOf(operational, ["storageStatus", "status"]), 40).toLowerCase();
    var dropped = numericValue(valueOf(operational, ["droppedEvents", "dropped"]));
    if (status === "disabled") {
      setNotice("Сбор телеметрии отключён. Дашборд показывает только уже сохранённые данные.", "");
    } else if (status === "degraded" || status === "error" || dropped > 0) {
      setNotice(
        "Телеметрия работает с потерями: отброшено событий — " + formatInteger(dropped) + ". MCP продолжает обслуживать запросы.",
        ""
      );
    } else {
      hideNotice();
    }
  }

  function setBusy(busy) {
    elements.refresh.disabled = busy;
    elements.refresh.textContent = busy ? "Обновляем…" : "Обновить";
    var submit = elements.form.querySelector('button[type="submit"]');
    submit.disabled = busy;
  }

  function setNotice(message, tone) {
    elements.notice.hidden = false;
    elements.notice.className = "notice" + (tone ? " notice--" + tone : "");
    elements.notice.textContent = message;
  }

  function hideNotice() {
    elements.notice.hidden = true;
    elements.notice.textContent = "";
    elements.notice.className = "notice";
  }

  function storageStatus(status) {
    if (status === "ok" || status === "healthy" || status === "ready") {
      return { label: "Работает", tone: "success" };
    }
    if (status === "degraded") {
      return { label: "Есть сбои", tone: "warning" };
    }
    if (status === "error" || status === "failed" || status === "unavailable") {
      return { label: "Недоступно", tone: "error" };
    }
    if (status === "disabled") {
      return { label: "Отключено", tone: "neutral" };
    }
    return { label: "Нет данных", tone: "neutral" };
  }

  function outcomeLabel(outcome) {
    if (outcome === "success") return "Успех";
    if (outcome === "error") return "Ошибка";
    if (outcome === "rejected") return "Отклонено";
    return outcome || "Не определён";
  }

  function outcomeClass(outcome) {
    return ["success", "error", "rejected"].includes(outcome) ? outcome : "neutral";
  }

  function riskLabel(risk) {
    if (risk === "read") return "чтение";
    if (risk === "write") return "запись";
    if (risk === "high-risk" || risk === "high_risk") return "высокий риск";
    if (risk === "sensitive") return "чувствительный";
    return risk;
  }

  function riskClassName(risk) {
    if (risk === "high_risk") return "high-risk";
    return ["read", "write", "high-risk", "sensitive"].includes(risk)
      ? risk
      : "write";
  }

  function normaliseWeekday(value) {
    if (typeof value === "number" || /^\d+$/.test(String(value || ""))) {
      var day = Number(value);
      if (day === 0) return 6;
      if (day >= 1 && day <= 7) return day - 1;
      return -1;
    }
    var normalised = safeText(value, 20).toLowerCase();
    var names = {
      mon: 0,
      monday: 0,
      "пн": 0,
      tue: 1,
      tuesday: 1,
      "вт": 1,
      wed: 2,
      wednesday: 2,
      "ср": 2,
      thu: 3,
      thursday: 3,
      "чт": 3,
      fri: 4,
      friday: 4,
      "пт": 4,
      sat: 5,
      saturday: 5,
      "сб": 5,
      sun: 6,
      sunday: 6,
      "вс": 6,
    };
    return Object.prototype.hasOwnProperty.call(names, normalised)
      ? names[normalised]
      : -1;
  }

  function formatBucketLabel(value) {
    var date = parseDate(value);
    if (!date) return safeText(value, 20) || "—";
    return state.filters.range === "24h"
      ? hourFormatter.format(date)
      : dayFormatter.format(date);
  }

  function formatBucketTitle(value) {
    var date = parseDate(value);
    return date ? dateTimeFormatter.format(date) + " МСК" : safeText(value, 50) || "Период";
  }

  function formatDateTime(value) {
    var date = parseDate(value);
    return date ? dateTimeFormatter.format(date) + " МСК" : "—";
  }

  function parseDate(value) {
    if (!value) return null;
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatInteger(value) {
    var number = numericValue(value);
    if (value === undefined || value === null || value === "" || !Number.isFinite(number)) {
      return "—";
    }
    return Math.round(number).toLocaleString("ru-RU");
  }

  function formatPercent(value) {
    if (value === undefined || value === null || value === "") return "—";
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (Math.abs(number) <= 1) number *= 100;
    return number.toLocaleString("ru-RU", {
      minimumFractionDigits: Number.isInteger(number) ? 0 : 1,
      maximumFractionDigits: 1,
    }) + "%";
  }

  function normalisePercent(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, Math.abs(number) <= 1 ? number : number / 100));
  }

  function formatDuration(value) {
    if (value === undefined || value === null || value === "") return "—";
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number < 1000) return Math.round(number).toLocaleString("ru-RU") + " мс";
    return (number / 1000).toLocaleString("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + " с";
  }

  function formatBytes(value) {
    if (value === undefined || value === null || value === "") return "—";
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    if (number < 1024) return Math.round(number) + " Б";
    if (number < 1024 * 1024) return (number / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " КБ";
    if (number < 1024 * 1024 * 1024) {
      return (number / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " МБ";
    }
    return (number / (1024 * 1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ГБ";
  }

  function valueOf(object, keys) {
    if (!object || typeof object !== "object") return undefined;
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (object[key] !== undefined && object[key] !== null) {
        return object[key];
      }
    }
    return undefined;
  }

  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function arrayValue(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    return [];
  }

  function unwrapPayload(payload) {
    if (
      payload &&
      objectValue(payload.data) &&
      !Object.prototype.hasOwnProperty.call(payload, "items") &&
      !Object.prototype.hasOwnProperty.call(payload, "activity") &&
      !Object.prototype.hasOwnProperty.call(payload, "activeTenants")
    ) {
      return payload.data;
    }
    return objectValue(payload) || {};
  }

  function numericValue(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function safeText(value, maxLength) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return "";
    return String(value).slice(0, maxLength || 180);
  }

  function trimValue(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function safeCursor(value) {
    if (value === undefined || value === null || value === "") return null;
    return String(value).slice(0, 1024);
  }

  function joinParts(parts, separator) {
    return parts.filter(Boolean).join(separator);
  }

  function padTwo(value) {
    return String(value).padStart(2, "0");
  }

  function emptyState(message) {
    return createElement("div", "empty-state", message);
  }

  function appendEmptyTableRow(tbody, columnCount, message) {
    var row = createElement("tr", "empty-state--table");
    var cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.textContent = message;
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function createCell(text, className) {
    var cell = createElement("td", className || "", text);
    return cell;
  }

  function numericCell(text) {
    return createCell(text, "number-cell");
  }

  function createElement(tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function createSvgElement(tagName) {
    return document.createElementNS("http://www.w3.org/2000/svg", tagName);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function messageFromError(error, fallback) {
    return error && error.message ? safeText(error.message, 180) : fallback;
  }

  function isAbortError(error) {
    return error && error.name === "AbortError";
  }
})();
