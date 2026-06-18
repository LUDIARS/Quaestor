import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// このファイルをコピーして vite.config.ts を作成してください。
// cp vite.config.example.ts vite.config.ts
//
// 外部ホスト (Cloudflare Tunnel / Tailscale 等) は quaestor.config.json の
// web.allowedHosts に追加してください (設定 UI からも変更可):
//
//   { "web": { "allowedHosts": ["quaestor.example.com"] } }
//
// env override: web/.env.local に VITE_ALLOWED_HOSTS=host1,host2 を設定しても可。
// vite.config.ts はドメイン情報を含むため gitignore 対象です。

// LUDIARS port-map: vite dev は 5170-5199 レンジ。 Quaestor web は 5177。
// (5176 は Cernere が vite auto-increment で滑って占有していた、 衝突回避のため)
// Backend は 17400 で listen するので /v1/* と /health を proxy する。

function loadConfigHosts(): string[] {
  const path = resolve(process.cwd(), "../quaestor.config.json");
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { web?: { allowedHosts?: unknown } };
    const hosts = cfg?.web?.allowedHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  } catch { return []; }
}

const configHosts = loadConfigHosts();
const envHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    host: true,
    allowedHosts: ["localhost", "127.0.0.1", ...configHosts, ...envHosts],
    proxy: {
      "/v1": "http://127.0.0.1:17400",
      "/health": "http://127.0.0.1:17400",
    },
  },
});
