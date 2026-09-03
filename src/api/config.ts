/**
 * /v1/config/* — アプリ設定の読み書き API。
 *
 * web.allowedHosts と training.gaBench.enabled は quaestor.config.json に書き戻す。
 * どちらもプロセス起動時に読む値なので、**反映は再起動後** (応答の note で伝える)。
 */

import { Hono, type Context } from "hono";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAppConfig } from "../services/app-config.js";
import { isDirectLoopbackRequest } from "../shared/local-request.js";

/** 設定変更が効くのは次の起動から。UI にそのまま出す文言 */
const WEB_RESTART_NOTE = "Vite dev server の再起動後に反映されます";
const SERVER_RESTART_NOTE = "Quaestor backend の再起動後に反映されます";

class InvalidConfigFileError extends Error {}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new InvalidConfigFileError();
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidConfigFileError();
  }
  return parsed as Record<string, unknown>;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return (value && typeof value === "object" && !Array.isArray(value))
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function writeConfigFile(configPath: string, cfg: Record<string, unknown>): void {
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    renameSync(temporary, configPath);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* failed atomic-write cleanup */ }
    }
  }
}

function readWebHosts(configPath: string): string[] {
  try {
    const hosts = objectAt(readConfigFile(configPath), "web").allowedHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return []; // 読み取りは従来どおり best-effort。更新経路は壊れた設定を上書きせず失敗させる
  }
}

function writeWebHosts(configPath: string, hosts: string[]): void {
  const cfg = readConfigFile(configPath);
  const web = objectAt(cfg, "web");
  web.allowedHosts = hosts;
  cfg.web = web;
  writeConfigFile(configPath, cfg);
}

/**
 * `training.gaBench.enabled` だけを差し替える ($comment や hour / sidecarUrl は残す)。
 * 夜間ジョブは server.ts が起動時に組み立てるので、ここで走っているジョブは動かさない。
 */
function writeGaBenchEnabled(configPath: string, enabled: boolean): void {
  const cfg = readConfigFile(configPath);
  const training = objectAt(cfg, "training");
  const gaBench = objectAt(training, "gaBench");
  gaBench.enabled = enabled;
  training.gaBench = gaBench;
  cfg.training = training;
  writeConfigFile(configPath, cfg);
}

export function configRouter(
  configFile = "quaestor.config.json",
  canAccess: (context: Context) => boolean = isDirectLoopbackRequest,
): Hono {
  const app = new Hono();
  const configPath = resolve(process.cwd(), configFile);

  app.use("*", async (c, next) => {
    if (!canAccess(c)) return c.json({ error: "direct loopback access required" }, 403);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/web", (c) => c.json({ allowed_hosts: readWebHosts(configPath) }));

  app.put("/web", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.allowed_hosts)) {
      return c.json({ error: "body.allowed_hosts (string[]) required" }, 400);
    }
    const hosts = (body.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string");
    try {
      writeWebHosts(configPath, hosts);
    } catch (error: unknown) {
      if (error instanceof InvalidConfigFileError) {
        return c.json({ error: "config file is not valid JSON" }, 409);
      }
      throw error;
    }
    return c.json({ allowed_hosts: readWebHosts(configPath), note: WEB_RESTART_NOTE });
  });

  // GET/PUT /ga-bench — OCR-GA 夜間評価バッチの on/off (設定ページ「OCR 進化」カード)
  // 返すのは env override 込みの実効値。env で固定されていれば書き戻しても値は変わらない。
  app.get("/ga-bench", (c) => c.json({ enabled: loadAppConfig(configPath).training.gaBench.enabled }));

  app.put("/ga-bench", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    try {
      writeGaBenchEnabled(configPath, body.enabled);
    } catch (error: unknown) {
      if (error instanceof InvalidConfigFileError) {
        return c.json({ error: "config file is not valid JSON" }, 409);
      }
      throw error;
    }
    return c.json({ enabled: loadAppConfig(configPath).training.gaBench.enabled, note: SERVER_RESTART_NOTE });
  });

  return app;
}
