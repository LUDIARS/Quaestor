/**
 * 他サービスの endpoint を Excubitor catalog から解決する。
 *
 * ポート番号の正本は各リポジトリ直下の `excubitor.catalog.yaml` (Excubitor/catalog/FRAGMENTS.md)
 * だけであり、 コードへ焼き付けない。 解決順は
 *   1. Excubitor が `provides:` から注入する env (例 CONCORDIA_URL)
 *   2. ${ARS_ROOT} 直下の各リポの catalog 断片に宣言された port
 * とし、 どちらも取れなければ null を返して呼び出し側が「未設定」として扱えるようにする。
 *
 * YAML は `services:` 配下の平坦なキーしか見ないので、 依存を増やさず行走査で読む。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CATALOG_FILENAME = "excubitor.catalog.yaml";
const cache = new Map<string, string | null>();

export interface ServiceEndpointOptions {
  /** 探索起点 (既定 env ARS_ROOT、 無ければプロセスの親ディレクトリ) */
  arsRoot?: string;
  /** `provides:` 由来の env 名 (例 CONCORDIA_URL) */
  envName?: string;
  /** catalog の host 表記は環境依存なのでループバック固定にする */
  host?: string;
  /** テスト用。 既定は process.env */
  env?: NodeJS.ProcessEnv;
  useCache?: boolean;
}

/** catalog に宣言された service の base URL。 見つからなければ null。 */
export function resolveServiceBaseUrl(code: string, opts: ServiceEndpointOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const fromEnv = opts.envName ? env[opts.envName]?.trim() : undefined;
  if (fromEnv) return loopbackBaseUrl(fromEnv);

  const arsRoot = resolve(opts.arsRoot ?? env.ARS_ROOT?.trim() ?? dirname(process.cwd()));
  const cacheKey = `${arsRoot}|${code}`;
  if (opts.useCache !== false && cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const port = findServicePort(arsRoot, code);
  const url = port === null ? null : `http://${opts.host ?? "127.0.0.1"}:${port}`;
  if (opts.useCache !== false) cache.set(cacheKey, url);
  return url;
}

/** テスト間で catalog の探索結果を持ち越さないための解放。 */
export function clearServiceEndpointCache(): void {
  cache.clear();
}

function findServicePort(arsRoot: string, code: string): number | null {
  for (const path of catalogPaths(arsRoot)) {
    const port = portFromCatalog(readCatalog(path), code);
    if (port !== null) return port;
  }
  return null;
}

function catalogPaths(arsRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(arsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(arsRoot, entry.name, CATALOG_FILENAME));
  } catch {
    return [];
  }
  return entries.filter((path) => existsSync(path));
}

function readCatalog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * `services:` 配下の 1 エントリ (`  - code: <code>`) を見つけ、 同じエントリの `port:` を返す。
 * ネストしたブロック (health / env / provides) の port らしき値は拾わない。
 */
export function portFromCatalog(yaml: string, code: string): number | null {
  let inEntry = false;
  let entryIndent = 0;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const itemMatch = /^-\s+(.*)$/.exec(line.trimStart());
    if (itemMatch) {
      inEntry = scalarValue(itemMatch[1] ?? "", "code") === code;
      entryIndent = indent;
      continue;
    }
    if (!inEntry) continue;
    if (indent <= entryIndent) {
      inEntry = false; // エントリの外へ出た
      continue;
    }
    // ネストしたブロック配下の値は同じ深さに揃わないので、 直下の行だけ見る。
    if (indent !== entryIndent + 2) continue;
    const port = scalarValue(line.trim(), "port");
    if (port !== null && /^\d{1,5}$/.test(port)) {
      const value = Number(port);
      if (value >= 1 && value <= 65_535) return value;
    }
  }
  return null;
}

/** 内部 API を外部ホストへ向けないよう、注入 endpoint も loopback の origin のみに制限する。 */
function loopbackBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if (url.protocol !== "http:" || !isLoopback || url.username || url.password
      || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function scalarValue(line: string, key: string): string | null {
  const matched = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
  if (!matched) return null;
  return (matched[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
