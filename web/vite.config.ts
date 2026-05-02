import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LUDIARS port-map: vite dev は 5170-5199 レンジ。 Quaestor web は 5177。
// (5176 は Cernere が vite auto-increment で滑って占有していた、 衝突回避のため)
// Backend は 17400 で listen するので /v1/* と /health を proxy する。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    host: true,
    allowedHosts: ["quaestor.vtn-game.com", "localhost", "127.0.0.1"],
    proxy: {
      "/v1": "http://127.0.0.1:17400",
      "/health": "http://127.0.0.1:17400",
    },
  },
});
