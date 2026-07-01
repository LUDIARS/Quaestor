import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ConcordiaCostOneShot {
  service: string;
  provider: string;
  command: string;
  model?: string | null;
  cwd?: string | null;
  prompt: string;
  status: "ok" | "error" | "timeout" | "unknown";
  exit_code?: number | null;
  duration_ms?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
}

function baseUrl(): string {
  const direct = process.env.CONCORDIA_URL?.trim();
  if (direct) return direct.replace(/\/+$/, "");
  const host = process.env.CONCORDIA_HOST?.trim() || "127.0.0.1";
  const port = process.env.CONCORDIA_PORT?.trim() || "11111";
  return `http://${host}:${port}`;
}

function queuePath(): string {
  return process.env.CONCORDIA_COST_ONESHOT_QUEUE?.trim()
    || join(process.cwd(), "logs", "cost-one-shot-queue.jsonl");
}

export async function reportConcordiaCostOneShot(payload: ConcordiaCostOneShot): Promise<void> {
  try {
    const res = await fetch(`${baseUrl()}/v1/cost/one-shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    try {
      const path = queuePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(payload) + "\n", "utf8");
    } catch {
      // Cost reporting is best-effort.
    }
  }
}
