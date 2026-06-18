import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// このファイルをコピーして vite.config.ts を作成してください。
// cp vite.config.example.ts vite.config.ts
//
// 外部ホスト (Cloudflare Tunnel / Tailscale 等) からアクセスする場合は
// web/.env.local に VITE_ALLOWED_HOSTS を設定してください:
//
//   VITE_ALLOWED_HOSTS=quaestor.example.com
//
// vite.config.ts はドメイン情報を含むため gitignore 対象です。

// LUDIARS port-map: vite dev は 5170-5199 レンジ。 Quaestor web は 5177。
// (5176 は Cernere が vite auto-increment で滑って占有していた、 衝突回避のため)
// Backend は 17400 で listen するので /v1/* と /health を proxy する。
const extraHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    host: true,
    allowedHosts: ["localhost", "127.0.0.1", ...extraHosts],
    proxy: {
      "/v1": "http://127.0.0.1:17400",
      "/health": "http://127.0.0.1:17400",
    },
  },
});
