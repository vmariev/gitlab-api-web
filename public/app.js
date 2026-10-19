import { PRESETS } from "./presets.js";

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "glc.history";
const PATH_VALUES_KEY = "glc.pathValues";
const HISTORY_LIMIT = 50;
const HIGHLIGHT_LIMIT = 1_000_000;
const FETCH_ALL_PER_PAGE = "100"; // максимум GitLab
const FETCH_ALL_MAX_PAGES = 1000;
// По HTTP/2 GitLab не присылает statusText.
const STATUS_TEXT = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  409: "Conflict", 412: "Precondition Failed", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

const state = {
  queryRows: [],
  pathValues: readStorage(PATH_VALUES_KEY, {}),
  history: readStorage(HISTORY_KEY, []),
  lastResponse: null,
  lastPath: "",
  sending: false,
  fetchAll: null, // { cancelled } во время сбора всех страниц
};

// ---------- storage ----------

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим и т.п. — не критично */
  }
}

// ---------- utils ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function highlightJson(value) {
  const json = JSON.stringify(value, null, 2);
  if (json.length > HIGHLIGHT_LIMIT) return escapeHtml(json);
  return escapeHtml(json).replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon) => {
      let cls = "j-num";
      if (str) cls = colon ? "j-key" : "j-str";
      else if (m === "true" || m === "false") cls = "j-bool";
      else if (m === "null") cls = "j-null";
      return `<span class="${cls}">${m}</span>`;
    },
  );
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function methodBadge(method) {
  return el("span", { class: `m m-${method}` }, method);
}

// ---------- presets & history ----------

function renderPresets() {
  const filter = $("presetFilter").value.trim().toLowerCase();
  const panel = $("presetsPanel");
  panel.replaceChildren();
  for (const group of PRESETS) {
    const items = group.items.filter(
      (p) => !filter || `${group.group} ${p.name} ${p.path}`.toLowerCase().includes(filter),
    );
    if (!items.length) continue;
    panel.append(
      el(
        "div",
        { class: "preset-group" },
        el("h4", {}, group.group),
        ...items.map((p) =>
          el(
            "button",
            { class: "preset", type: "button", title: `${p.method} ${p.path}`, onclick: () => loadPreset(p) },
            methodBadge(p.method),
            el("span", { class: "preset-name" }, p.name),
          ),
        ),
      ),
    );
  }
  if (!panel.children.length) panel.append(el("div", { class: "kv-empty" }, "Ничего не найдено"));
}

function loadPreset(p) {
  $("method").value = p.method;
  $("path").value = p.path;
  state.queryRows = Object.entries(p.query ?? {}).map(([key, value]) => ({ key, value }));
  $("body").value = p.body !== undefined ? JSON.stringify(p.body, null, 2) : "";
  syncForm();
  focusFirstEmptyParam();
}

function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();
  if (!state.history.length) {
    list.append(el("li", { class: "kv-empty" }, "Пока пусто"));
    return;
  }
  const filter = $("presetFilter").value.trim().toLowerCase();
  for (const h of state.history) {
    if (filter && !`${h.method} ${h.resolvedPath}`.toLowerCase().includes(filter)) continue;
    const statusCls = h.status >= 400 || !h.status ? "s4" : "s2";
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          {
            class: "history-item",
            type: "button",
            title: `${h.resolvedPath}\n${new Date(h.ts).toLocaleString()}`,
            onclick: () => loadHistory(h),
          },
          methodBadge(h.method),
          el("span", { class: "history-path" }, h.resolvedPath),
          el("span", { class: `history-status status ${statusCls}` }, String(h.status || "ERR")),
        ),
      ),
    );
  }
}

function loadHistory(h) {
  $("method").value = h.method;
  $("path").value = h.path;
  state.queryRows = h.query.map((r) => ({ ...r }));
  Object.assign(state.pathValues, h.params);
  $("body").value = h.body ?? "";
  syncForm();
}

function addHistory(entry) {
  state.history = [entry, ...state.history].slice(0, HISTORY_LIMIT);
  writeStorage(HISTORY_KEY, state.history);
  renderHistory();
}

// ---------- request form ----------

function pathParamNames(path) {
  const names = [];
  for (const m of path.split("?")[0].matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function renderPathParams() {
  const names = pathParamNames($("path").value);
  $("pathParamsSection").classList.toggle("hidden", !names.length);
  const wrap = $("pathParams");
  // Не перерисовываем, если набор параметров не изменился — иначе теряется фокус при вводе пути.
  if (wrap.dataset.names === names.join(",")) return;
  wrap.dataset.names = names.join(",");
  wrap.replaceChildren(
    ...names.map((name) =>
      el(
        "div",
        { class: "kv-row path-param" },
        el("label", { class: "kv-key-label", for: `pp-${name}` }, `:${name}`),
        el("input", {
          class: "input",
          id: `pp-${name}`,
          value: state.pathValues[name] ?? "",
          placeholder: name === "id" ? "123 или group/project" : name,
          spellcheck: "false",
          oninput: (e) => {
            state.pathValues[name] = e.target.value;
            writeStorage(PATH_VALUES_KEY, state.pathValues);
          },
        }),
      ),
    ),
  );
}

function focusFirstEmptyParam() {
  const empty = [...$("pathParams").querySelectorAll("input")].find((i) => !i.value.trim());
  (empty ?? $("path")).focus();
}

function renderQueryRows() {
  const wrap = $("queryParams");
  if (!state.queryRows.length) {
    wrap.replaceChildren(el("div", { class: "kv-empty" }, "Нет параметров. Пустые значения не отправляются."));
    return;
  }
  wrap.replaceChildren(
    ...state.queryRows.map((row, i) =>
      el(
        "div",
        { class: "kv-row" },
        el("input", {
          class: "input",
          value: row.key,
          placeholder: "ключ",
          spellcheck: "false",
          oninput: (e) => (row.key = e.target.value),
        }),
        el("input", {
          class: "input",
          value: row.value,
          placeholder: "значение",
          spellcheck: "false",
          oninput: (e) => (row.value = e.target.value),
        }),
        el(
          "button",
          {
            class: "kv-remove",
            type: "button",
            title: "Удалить",
            onclick: () => {
              state.queryRows.splice(i, 1);
              renderQueryRows();
            },
          },
          "×",
        ),
      ),
    ),
  );
}

function setQueryParam(key, value) {
  const row = state.queryRows.find((r) => r.key === key);
  if (row) row.value = value;
  else state.queryRows.push({ key, value });
  renderQueryRows();
}

// Если в путь вставили "?a=1&b=2" или полный URL — раскладываем по полям.
function normalizePathInput() {
  let raw = $("path").value.trim();
  const apiIdx = raw.indexOf("/api/v4/");
  if (/^https?:\/\//i.test(raw) && apiIdx !== -1) raw = raw.slice(apiIdx + "/api/v4".length);
  else if (raw.startsWith("/api/v4/")) raw = raw.slice("/api/v4".length);
  const [pathPart, queryPart] = raw.split(/\?(.*)/s);
  if (queryPart !== undefined) {
    for (const [k, v] of new URLSearchParams(queryPart)) setQueryParam(k, v);
  }
  $("path").value = pathPart && !pathPart.startsWith("/") ? `/${pathPart}` : pathPart;
  renderPathParams();
}

function syncForm() {
  const method = $("method").value;
  $("bodySection").classList.toggle("hidden", method === "GET");
  $("fetchAllBtn").classList.toggle("hidden", method !== "GET");
  renderPathParams();
  renderQueryRows();
  validateBody();
}

function validateBody() {
  const text = $("body").value.trim();
  let err = "";
  if (text && $("method").value !== "GET") {
    try {
      JSON.parse(text);
    } catch (e) {
      err = `Невалидный JSON: ${e.message}`;
    }
  }
  $("bodyError").textContent = err;
  $("body").classList.toggle("invalid", Boolean(err));
  return !err;
}

function buildRequest() {
  const method = $("method").value;
  const template = $("path").value.trim() || "/";
  const params = {};
  const missing = [];
  const resolvedPath = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const v = (state.pathValues[name] ?? "").trim();
    if (!v) missing.push(name);
    params[name] = v;
    return encodeURIComponent(v);
  });
  if (missing.length) throw new Error(`Заполните параметры пути: ${missing.map((n) => ":" + n).join(", ")}`);
  if (!validateBody()) throw new Error("Исправьте JSON в теле запроса");

  const query = state.queryRows.filter((r) => r.key.trim() && r.value !== "").map((r) => ({ key: r.key.trim(), value: r.value }));
  const bodyText = method === "GET" ? "" : $("body").value.trim();
  return {
    payload: { method, path: resolvedPath, query, body: bodyText ? JSON.parse(bodyText) : undefined },
    historyEntry: {
      method,
      path: template,
      resolvedPath,
      params,
      query: state.queryRows.map((r) => ({ ...r })),
      body: bodyText,
    },
  };
}

async function send() {
  if (state.sending) return;
  normalizePathInput();
  let built;
  try {
    built = buildRequest();
  } catch (e) {
    showError(e.message);
    return;
  }
  if (["DELETE", "PUT", "PATCH"].includes(built.payload.method) && !confirm(`Выполнить ${built.payload.method} ${built.payload.path}?`)) {
    return;
  }

  state.sending = true;
  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Отправка…";
  $("respStatus").className = "status";
  $("respStatus").textContent = "…";
  try {
    const res = await api("POST", "/api/request", built.payload);
    state.lastPath = built.payload.path;
    showResponse(res);
    addHistory({ ...built.historyEntry, status: res.status, ts: Date.now() });
  } catch (e) {
    showError(e.message);
    addHistory({ ...built.historyEntry, status: 0, ts: Date.now() });
  } finally {
    state.sending = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Отправить";
  }
}

// Обходит все страницы и склеивает массивы в один буфер.
// Следующая страница берётся из Link rel="next" (работает и для offset-, и для keyset-пагинации),
// иначе из x-next-page.
async function fetchAllPages() {
  if (state.fetchAll) {
    state.fetchAll.cancelled = true;
    return;
  }
  if (state.sending) return;
  normalizePathInput();
  let built;
  try {
    built = buildRequest();
  } catch (e) {
    showError(e.message);
    return;
  }
  if (built.payload.method !== "GET") return;

  const run = { cancelled: false };
  state.fetchAll = run;
  state.sending = true;
  $("sendBtn").disabled = true;
  $("fetchAllBtn").textContent = "Стоп";
  $("fetchAllBtn").classList.add("btn-danger");

  let query = [
    ...built.payload.query.filter((q) => q.key !== "page" && q.key !== "per_page"),
    { key: "per_page", value: FETCH_ALL_PER_PAGE },
  ];
  const items = [];
  let pages = 0;
  let durationMs = 0;
  let first = null;
  let last = null;
  let stopReason = "";

  try {
    while (pages < FETCH_ALL_MAX_PAGES) {
      const res = await api("POST", "/api/request", { ...built.payload, query });
      pages++;
      durationMs += res.durationMs;
      first ??= res;
      last = res;
      if (!res.ok) {
        stopReason = `ошибка ${res.status} на странице ${pages}`;
        break;
      }
      if (!Array.isArray(res.body)) {
        stopReason = pages === 1 ? "ответ не является списком" : `страница ${pages} вернула не список`;
        break;
      }
      items.push(...res.body);
      showFetchProgress(pages, res.headers["x-total-pages"], items.length, res.headers["x-total"]);

      const nextQuery = nextPageQuery(res.headers, query);
      if (!nextQuery) break;
      if (run.cancelled) {
        stopReason = "остановлено";
        break;
      }
      query = nextQuery;
    }
    if (pages >= FETCH_ALL_MAX_PAGES && !stopReason) stopReason = `достигнут лимит ${FETCH_ALL_MAX_PAGES} страниц`;

    if (!first.ok || (pages === 1 && !Array.isArray(first.body))) {
      // Первая же страница не подошла — показываем её как обычный ответ.
      showResponse(first);
    } else {
      showResponse({ ...last, url: first.url, headers: {}, body: items, durationMs });
      $("pager").classList.add("hidden");
      $("respMeta").textContent = [`${items.length} шт.`, `${pages} стр.`, `${durationMs} мс`, stopReason && `⚠ ${stopReason}`]
        .filter(Boolean)
        .join(" · ");
      if (stopReason) $("respStatus").className = "status s4";
    }
    state.lastPath = built.payload.path;
    addHistory({ ...built.historyEntry, status: last.status, ts: Date.now() });
  } catch (e) {
    showError(items.length ? `${e.message}\n\nСобрано до ошибки: ${items.length} шт. (${pages} стр.)` : e.message);
    if (items.length) state.lastResponse = items;
  } finally {
    state.fetchAll = null;
    state.sending = false;
    $("sendBtn").disabled = false;
    $("fetchAllBtn").textContent = "Все страницы";
    $("fetchAllBtn").classList.remove("btn-danger");
  }
}

function nextPageQuery(headers, query) {
  const link = headers.link ?? "";
  const m = link.split(",").map((p) => p.match(/<([^>]+)>\s*;\s*rel="?next"?/)).find(Boolean);
  if (m) {
    try {
      return [...new URL(m[1]).searchParams].map(([key, value]) => ({ key, value }));
    } catch {
      /* битая ссылка — пробуем x-next-page */
    }
  }
  const next = headers["x-next-page"];
  return next ? [...query.filter((q) => q.key !== "page"), { key: "page", value: next }] : null;
}

function showFetchProgress(page, totalPages, count, total) {
  $("respStatus").className = "status";
  $("respStatus").textContent = "…";
  $("respMeta").textContent = `стр. ${page}${totalPages ? ` из ${totalPages}` : ""} · ${count}${total ? ` из ${total}` : ""} шт.`;
  $("respBody").textContent = "Собираю страницы… Нажмите «Стоп», чтобы прервать.";
}

// ---------- response ----------

function showResponse(res) {
  state.lastResponse = res.body;
  const s = $("respStatus");
  s.className = `status s${String(res.status)[0]}`;
  s.textContent = `${res.status} ${res.statusText || STATUS_TEXT[res.status] || ""}`.trim();

  const meta = [`${res.durationMs} мс`];
  if (Array.isArray(res.body)) meta.push(`${res.body.length} шт.`);
  if (res.headers["x-total"]) meta.push(`всего ${res.headers["x-total"]}`);
  if (res.headers["ratelimit-remaining"]) meta.push(`лимит ${res.headers["ratelimit-remaining"]}/${res.headers["ratelimit-limit"] ?? "?"}`);
  $("respMeta").textContent = meta.join(" · ");
  $("respUrl").textContent = res.url;

  const headerRows = Object.entries(res.headers).map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, v)));
  $("respHeaders").replaceChildren(...headerRows);
  $("respHeadersWrap").classList.toggle("hidden", !headerRows.length);

  const body = $("respBody");
  if (res.body === "" || res.body === undefined) body.innerHTML = '<span class="muted">(пустое тело)</span>';
  else if (typeof res.body === "string") body.textContent = res.body;
  else body.innerHTML = highlightJson(res.body);

  const next = res.headers["x-next-page"];
  const prev = res.headers["x-prev-page"];
  $("pager").classList.toggle("hidden", !next && !prev);
  $("nextPage").disabled = !next;
  $("prevPage").disabled = !prev;
  $("nextPage").dataset.page = next ?? "";
  $("prevPage").dataset.page = prev ?? "";
  const page = res.headers["x-page"];
  const total = res.headers["x-total-pages"];
  $("pageInfo").textContent = page ? `стр. ${page}${total ? ` из ${total}` : ""}` : "";
}

function showError(message) {
  state.lastResponse = null;
  $("respStatus").className = "status serr";
  $("respStatus").textContent = "Ошибка";
  $("respMeta").textContent = "";
  $("respUrl").textContent = "";
  $("respHeaders").replaceChildren();
  $("respHeadersWrap").classList.add("hidden");
  $("pager").classList.add("hidden");
  $("respBody").textContent = message;
}

function goToPage(btn) {
  if (!btn.dataset.page) return;
  setQueryParam("page", btn.dataset.page);
  send();
}

function downloadResponse() {
  const data = state.lastResponse;
  if (data === null || data === undefined || data === "") return;
  const isText = typeof data === "string";
  const blob = new Blob([isText ? data : JSON.stringify(data, null, 2)], {
    type: isText ? "text/plain;charset=utf-8" : "application/json",
  });
  const slug = state.lastPath.replace(/%2F/gi, "-").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "response";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = el("a", { href: URL.createObjectURL(blob), download: `gitlab-${slug}-${stamp}.${isText ? "txt" : "json"}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- settings ----------

async function refreshConnection(runTest) {
  let s;
  try {
    s = await api("GET", "/api/settings");
  } catch (e) {
    setConnection("err", `Сервер недоступен: ${e.message}`);
    return null;
  }
  $("baseUrl").value = s.baseUrl;
  $("allowSelfSigned").checked = s.allowSelfSigned;
  $("token").value = "";
  $("token").placeholder = s.hasToken ? `Сохранён: ${s.tokenMasked} (оставьте пустым, чтобы не менять)` : "glpat-…";
  $("pathPrefix").textContent = s.baseUrl ? `${s.baseUrl.replace(/^https?:\/\//, "")}/api/v4` : "/api/v4";
  $("pathPrefix").title = s.baseUrl ? `${s.baseUrl}/api/v4` : "";

  if (!s.baseUrl || !s.hasToken) {
    setConnection("", "Не настроено");
    return s;
  }
  setConnection("", s.baseUrl);
  if (runTest) {
    const r = await api("POST", "/api/settings/test").catch((e) => ({ ok: false, message: e.message }));
    setConnection(r.ok ? "ok" : "err", r.ok ? `${r.message.replace(/^Подключено как\s*/, "")} · ${s.baseUrl}` : r.message);
    return { ...s, test: r };
  }
  return s;
}

function setConnection(kind, text) {
  $("connDot").className = `dot ${kind}`;
  $("connText").textContent = text;
  $("connText").title = text;
}

function setTestResult(kind, text) {
  const t = $("testResult");
  t.className = `test-result ${kind}`;
  t.textContent = text;
}

async function saveSettingsFromForm() {
  const body = {
    baseUrl: $("baseUrl").value,
    allowSelfSigned: $("allowSelfSigned").checked,
  };
  if ($("token").value.trim()) body.token = $("token").value.trim();
  await api("PUT", "/api/settings", body);
}

function initSettings() {
  const dialog = $("settingsDialog");
  $("openSettings").addEventListener("click", () => {
    setTestResult("", "");
    dialog.showModal();
  });

  $("saveSettings").addEventListener("click", async () => {
    if (!$("baseUrl").value.trim()) {
      setTestResult("err", "Укажите URL GitLab");
      return;
    }
    try {
      await saveSettingsFromForm();
      const s = await refreshConnection(true);
      if (s?.test && !s.test.ok) {
        setTestResult("err", `Сохранено, но проверка не прошла: ${s.test.message}`);
        return;
      }
      dialog.close();
      toast("Настройки сохранены");
    } catch (e) {
      setTestResult("err", e.message);
    }
  });

  $("testConn").addEventListener("click", async () => {
    setTestResult("", "Проверяю…");
    try {
      await saveSettingsFromForm();
      const s = await refreshConnection(true);
      if (!s?.hasToken) setTestResult("err", "Укажите токен");
      else setTestResult(s.test.ok ? "ok" : "err", s.test.message);
    } catch (e) {
      setTestResult("err", e.message);
    }
  });

  $("forgetToken").addEventListener("click", async () => {
    if (!confirm("Удалить сохранённый токен?")) return;
    await api("DELETE", "/api/settings/token");
    await refreshConnection(false);
    setTestResult("", "Токен удалён");
  });
}

// ---------- init ----------

function init() {
  renderPresets();
  renderHistory();
  syncForm();
  initSettings();

  $("requestForm").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !$("settingsDialog").open) {
      e.preventDefault();
      send();
    }
  });

  $("method").addEventListener("change", syncForm);
  $("path").addEventListener("input", renderPathParams);
  $("path").addEventListener("change", normalizePathInput);
  $("body").addEventListener("input", validateBody);
  $("addQuery").addEventListener("click", () => {
    state.queryRows.push({ key: "", value: "" });
    renderQueryRows();
    $("queryParams").querySelector(".kv-row:last-child input")?.focus();
  });
  $("formatBody").addEventListener("click", () => {
    if (!validateBody() || !$("body").value.trim()) return;
    $("body").value = JSON.stringify(JSON.parse($("body").value), null, 2);
  });

  $("nextPage").addEventListener("click", (e) => goToPage(e.currentTarget));
  $("prevPage").addEventListener("click", (e) => goToPage(e.currentTarget));
  $("fetchAllBtn").addEventListener("click", fetchAllPages);
  $("downloadResp").addEventListener("click", downloadResponse);
  $("copyResp").addEventListener("click", async () => {
    const text = typeof state.lastResponse === "string" ? state.lastResponse : JSON.stringify(state.lastResponse, null, 2);
    if (state.lastResponse === null || state.lastResponse === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Скопировано");
    } catch {
      toast("Не удалось скопировать");
    }
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("presetsPanel").classList.toggle("hidden", tab.dataset.tab !== "presets");
      $("historyPanel").classList.toggle("hidden", tab.dataset.tab !== "history");
    });
  }
  $("presetFilter").addEventListener("input", () => {
    renderPresets();
    renderHistory();
  });
  $("clearHistory").addEventListener("click", () => {
    state.history = [];
    writeStorage(HISTORY_KEY, state.history);
    renderHistory();
  });

  refreshConnection(true).then((s) => {
    if (s && (!s.baseUrl || !s.hasToken)) $("settingsDialog").showModal();
  });
}

init();
