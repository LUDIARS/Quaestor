/**
 * /v1/config/* — アプリ設定の読み書き API。
 *
 * web.allowedHosts は quaestor.config.json に書き戻す。
 * Vite dev server の再起動後に反映される。
 */

import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function readWebHosts(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { web?: { allowedHosts?: unknown } };
    const hosts = cfg?.web?.allowedHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  } catch { return []; }
}

function writeWebHosts(configPath: string, hosts: string[]): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>; } catch { /* ignore */ }
  }
  const web = (cfg.web && typeof cfg.web === "object" && !Array.isArray(cfg.web))
    ? { ...(cfg.web as Record<string, unknown>) }
    : {} as Record<string, unknown>;
  web.allowedHosts = hosts;
  cfg.web = web;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function configRouter(configFile = "quaestor.config.json"): Hono {
  const app = new Hono();
  const configPath = resolve(process.cwd(), configFile);

  app.get("/web", (c) => c.json({ allowed_hosts: readWebHosts(configPath) }));

  app.put("/web", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.allowed_hosts)) {
      return c.json({ error: "body.allowed_hosts (string[]) required" }, 400);
    }
    const hosts = (body.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string");
    writeWebHosts(configPath, hosts);
    return c.json({ allowed_hosts: readWebHosts(configPath), note: "Vite dev server の再起動後に反映されます" });
  });

  return app;
}
