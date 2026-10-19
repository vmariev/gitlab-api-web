import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Settings {
  baseUrl: string;
  token: string;
  allowSelfSigned: boolean;
}

export interface PublicSettings {
  baseUrl: string;
  hasToken: boolean;
  tokenMasked: string;
  allowSelfSigned: boolean;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const settingsFile = path.join(dataDir, "settings.json");

const defaults: Settings = { baseUrl: "", token: "", allowSelfSigned: false };

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(settingsFile, "utf8"));
    cache = { ...defaults, ...raw };
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export async function saveSettings(update: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = {
    baseUrl: update.baseUrl !== undefined ? normalizeBaseUrl(update.baseUrl) : current.baseUrl,
    // Пустой токен означает «оставить текущий».
    token: update.token ? update.token.trim() : current.token,
    allowSelfSigned: update.allowSelfSigned ?? current.allowSelfSigned,
  };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  await chmod(settingsFile, 0o600);
  cache = next;
  return next;
}

export async function clearToken(): Promise<Settings> {
  const current = await loadSettings();
  cache = { ...current, token: "" };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(settingsFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
  return cache;
}

export function toPublic(s: Settings): PublicSettings {
  return {
    baseUrl: s.baseUrl,
    hasToken: Boolean(s.token),
    tokenMasked: maskToken(s.token),
    allowSelfSigned: s.allowSelfSigned,
  };
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(8)}${token.slice(-4)}`;
}

export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  // Пользователь мог вставить ссылку вида https://host/api/v4 — отрезаем.
  let pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/, "");
  return `${parsed.origin}${pathname}`;
}
