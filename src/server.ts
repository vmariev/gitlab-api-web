import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyError, proxyRequest, type ProxyRequest } from "./gitlab.js";
import { clearToken, loadSettings, saveSettings, toPublic } from "./settings.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4317);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

type Handler = (req: IncomingMessage) => Promise<[number, unknown]>;

const routes: Record<string, Handler> = {
  "GET /api/settings": async () => [200, toPublic(await loadSettings())],

  "PUT /api/settings": async (req) => {
    const body = (await readJson(req)) as { baseUrl?: string; token?: string; allowSelfSigned?: boolean };
    try {
      return [200, toPublic(await saveSettings(body))];
    } catch {
      throw new ProxyError("Некорректный URL GitLab", 400);
    }
  },

  "DELETE /api/settings/token": async () => [200, toPublic(await clearToken())],

  "POST /api/settings/test": async () => {
    const res = await proxyRequest(await loadSettings(), { method: "GET", path: "/user" });
    const user = res.body as { username?: string; name?: string } | undefined;
    if (!res.ok) {
      const msg = res.status === 401 ? "Токен недействителен или истёк (401)" : `GitLab ответил ${res.status} ${res.statusText}`;
      return [200, { ok: false, message: msg }];
    }
    return [200, { ok: true, message: `Подключено как ${user?.name ?? ""} (@${user?.username ?? "?"})` }];
  },

  "POST /api/request": async (req) => {
    const body = (await readJson(req)) as ProxyRequest;
    return [200, await proxyRequest(await loadSettings(), body)];
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      // Защита от чужих сайтов (CSRF и DNS rebinding): только локальный Host и same-origin.
      if (!isLocalHost(req.headers.host)) throw new ProxyError("Недопустимый Host", 403);
      if (req.method !== "GET" && !isSameOrigin(req)) throw new ProxyError("Запрос с чужого origin отклонён", 403);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new ProxyError("Не найдено", 404);
      const [status, payload] = await handler(req);
      return sendJson(res, status, payload);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new ProxyError("Метод не поддерживается", 405);
    return await serveStatic(url.pathname, res);
  } catch (err) {
    if (err instanceof ProxyError) return sendJson(res, err.httpStatus, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: "Внутренняя ошибка сервера" });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Порт ${PORT} уже занят — скорее всего, приложение уже запущено в другом терминале.\n` +
        `Откройте http://${HOST}:${PORT}, остановите другой процесс (lsof -i :${PORT}) или запустите на другом порту: PORT=4318 npm run dev`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`GitLab API Web: http://${HOST}:${PORT}`);
});

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl и прочие не-браузерные клиенты
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ProxyError("Слишком большое тело запроса", 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProxyError("Тело запроса должно быть JSON", 400);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) throw new ProxyError("Не найдено", 404);
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    throw new ProxyError("Не найдено", 404);
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}
