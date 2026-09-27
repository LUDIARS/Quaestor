import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfigHosts(): string[] {
  const path = resolve(__dirname, "../quaestor.config.json");
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { web?: { allowedHosts?: unknown } };
    const hosts = cfg?.web?.allowedHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  } catch { return []; }
}

const configHosts = loadConfigHosts();
const envHosts = [process.env.VITE_ALLOWED_HOSTS, process.env.LUDIARS_ALLOWED_HOSTS].flatMap((value) => value?.split(",").map((host) => host.trim()).filter(Boolean) ?? []);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5117,
    strictPort: true,
    host: true,
    allowedHosts: ["localhost", "127.0.0.1", ...configHosts, ...envHosts],
    proxy: {
      // Vite string shorthand rewrites Host; OAuth needs the original public host.
      "/v1/gmail-auth": { target: "http://127.0.0.1:17400", changeOrigin: false },
      "/v1": "http://127.0.0.1:17400",
      "/health": "http://127.0.0.1:17400",
    },
  },
});
