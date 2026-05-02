import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LUDIARS port-map: vite dev は 5170-5199 レンジ。 Quaestor web は 5176。
// Backend は 17400 で listen するので /v1/* と /health を proxy する。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:17400",
      "/health": "http://127.0.0.1:17400",
    },
  },
});
