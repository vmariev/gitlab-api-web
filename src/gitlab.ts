import { Agent, fetch, type RequestInit, type Response } from "undici";
import type { Settings } from "./settings.js";

export interface ProxyRequest {
  method: string;
  path: string;
  query?: Array<{ key: string; value: string }>;
  body?: unknown;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

const EXPOSED_HEADERS = [
  "content-type",
  "x-total",
  "x-total-pages",
  "x-page",
  "x-per-page",
  "x-next-page",
  "x-prev-page",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-request-id",
  "link",
];

const TIMEOUT_MS = 30_000;

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export function buildUrl(baseUrl: string, apiPath: string, query: ProxyRequest["query"] = []): string {
  const p = apiPath.trim();
  if (!p.startsWith("/")) throw new ProxyError("Путь должен начинаться с «/», например /projects", 400);
  if (p.includes("://") || p.startsWith("//") || /(^|\/)\.\.(\/|$|\?)/.test(p)) {
    throw new ProxyError("Недопустимый путь", 400);
  }
  const apiRoot = new URL(`${baseUrl}/api/v4/`);
  const url = new URL(`${baseUrl}/api/v4${p}`);
  // URL нормализует «..» и «%2e%2e», поэтому проверяем итог: запрос обязан остаться внутри /api/v4.
  if (url.origin !== apiRoot.origin || !`${url.pathname}/`.startsWith(apiRoot.pathname)) {
    throw new ProxyError("Недопустимый путь", 400);
  }
  for (const { key, value } of query) {
    if (key.trim()) url.searchParams.append(key.trim(), value);
  }
  return url.toString();
}

export async function proxyRequest(settings: Settings, req: ProxyRequest): Promise<ProxyResponse> {
  if (!settings.baseUrl || !settings.token) {
    throw new ProxyError("Укажите URL GitLab и токен в настройках", 400);
  }
  const method = String(req.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new ProxyError(`Метод ${method} не поддерживается`, 400);

  const url = buildUrl(settings.baseUrl, String(req.path ?? ""), req.query);
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": settings.token,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (req.body !== undefined && req.body !== null && req.body !== "" && method !== "GET" && method !== "HEAD") {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    headers["Content-Type"] = "application/json";
  }

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(settings.allowSelfSigned ? { dispatcher: insecureAgent } : {}),
    } satisfies RequestInit);
  } catch (err) {
    throw new ProxyError(describeNetworkError(err), 502);
  }
  const durationMs = Math.round(performance.now() - started);

  const outHeaders: Record<string, string> = {};
  for (const name of EXPOSED_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null && v !== "") outHeaders[name] = v;
  }
  const location = res.headers.get("location");
  if (location) outHeaders["location"] = location;

  const text = method === "HEAD" ? "" : await res.text();
  let parsed: unknown = text;
  if (text && (res.headers.get("content-type") ?? "").includes("json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    durationMs,
    url: redactUrl(url),
    headers: outHeaders,
    body: parsed,
  };
}

function redactUrl(url: string): string {
  const u = new URL(url);
  for (const key of ["private_token", "access_token"]) {
    if (u.searchParams.has(key)) u.searchParams.set(key, "***");
  }
  return u.toString();
}

function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return `GitLab не ответил за ${TIMEOUT_MS / 1000} с`;
  const code = e?.cause?.code ?? "";
  if (code === "ENOTFOUND") return "Хост не найден — проверьте URL GitLab";
  if (code === "ECONNREFUSED") return "Соединение отклонено — проверьте URL и порт";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `Ошибка TLS-сертификата (${code}). Для self-hosted GitLab включите «Разрешить self-signed сертификат»`;
  }
  return `Сетевая ошибка: ${e?.cause?.message ?? e?.message ?? String(err)}`;
}
