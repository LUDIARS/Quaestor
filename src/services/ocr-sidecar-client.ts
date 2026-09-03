/**
 * OCR sidecar (PaddleOCR microservice, ocr-sidecar/main.py) の HTTP クライアント (backend 用)。
 *
 * ブラウザから sidecar を直叩きする経路 (公開面からは到達不能) の代わりに、backend が
 * `/detect` (multipart image + genome JSON) と `/health` を叩く。
 *
 *  - 1 並列: detect は直列化する (sidecar は CPU で 1 回 40 秒。重ねると全部遅くなる)
 *  - タイムアウト: 応答が無い sidecar を待ち続けない (AbortController、timer は必ず解放)
 *  - URL は呼び出し側が quaestor.config.json (ocrSidecar / training.gaBench.sidecarUrl) から渡す
 *
 * fetchImpl を DI してテストする (discord-notifier.ts と同じ流儀)。
 *
 * @implements SPEC-OCR-GA-EVAL-003 (spec/feature/ocr-ga-evaluation.md)
 */

import type { OcrGenome } from "./ocr-ga.js";

/** sidecar /detect が返す 1 行 (画像ピクセル座標) */
export interface OcrLine {
  polygon: Array<[number, number]>;
  /** [x, y, w, h] */
  bbox: [number, number, number, number];
  text: string;
  score: number;
}

export interface DetectResult {
  lines: OcrLine[];
  width: number;
  height: number;
  /** リクエスト送信〜応答受信 (ms)。fitness のコスト項に使う */
  elapsedMs: number;
}

export interface SidecarHealth {
  ok: boolean;
  model: string | null;
  /** sidecar が実際に使っている device。旧 sidecar は報告しないので null */
  device: "cpu" | "gpu" | null;
  requestedDevice: string | null;
  /** gpu 要求が CPU に落ちた理由 (無ければ null) */
  deviceError: string | null;
  paddleocrMajor: number | null;
}

export interface OcrSidecarClient {
  readonly baseUrl: string;
  health(): Promise<SidecarHealth>;
  detect(image: Buffer, genome: OcrGenome, filename?: string): Promise<DetectResult>;
}

export interface HttpOcrSidecarClientOptions {
  baseUrl: string;
  /** /detect のタイムアウト (ms)。初回はモデル読込で 100 秒超えるので既定 180 秒 */
  timeoutMs?: number;
  /** /health のタイムアウト (ms)。既定 5 秒 */
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** テスト用: 経過時間の時計 */
  now?: () => number;
}

const DEFAULT_DETECT_TIMEOUT_MS = 180_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export class HttpOcrSidecarClient implements OcrSidecarClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** detect を直列化するチェーン (失敗しても次を止めない) */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: HttpOcrSidecarClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async health(): Promise<SidecarHealth> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/health`, { method: "GET" }, this.healthTimeoutMs);
    if (!res.ok) throw new Error(`sidecar /health ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    const device = j.device === "gpu" ? "gpu" : j.device === "cpu" ? "cpu" : null;
    return {
      ok: j.ok === true,
      model: optionalString(j.model),
      device,
      requestedDevice: optionalString(j.requested_device),
      deviceError: optionalString(j.device_error),
      paddleocrMajor: typeof j.paddleocr_major === "number" ? j.paddleocr_major : null,
    };
  }

  detect(image: Buffer, genome: OcrGenome, filename = "receipt.jpg"): Promise<DetectResult> {
    return this.serialize(() => this.detectNow(image, genome, filename));
  }

  private async detectNow(image: Buffer, genome: OcrGenome, filename: string): Promise<DetectResult> {
    const form = new FormData();
    form.append("image", new Blob([image], { type: "image/jpeg" }), filename);
    form.append("genome", JSON.stringify(genome));

    const started = this.now();
    const res = await this.fetchWithTimeout(`${this.baseUrl}/detect`, { method: "POST", body: form }, this.timeoutMs);
    if (!res.ok) throw new Error(`sidecar /detect ${res.status}`);
    const j = (await res.json()) as { lines?: unknown; width?: unknown; height?: unknown };
    return {
      lines: parseLines(j.lines),
      width: typeof j.width === "number" ? j.width : 0,
      height: typeof j.height === "number" ? j.height : 0,
      elapsedMs: Math.max(0, this.now() - started),
    };
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // Receipt images contain personal data. Never forward them to a redirect target.
      return await this.fetchImpl(url, { ...init, redirect: "error", signal: ac.signal });
    } catch (e: unknown) {
      if (ac.signal.aborted) throw new Error(`sidecar request timed out after ${timeoutMs} ms: ${url}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseLines(raw: unknown): OcrLine[] {
  if (!Array.isArray(raw)) return [];
  const out: OcrLine[] = [];
  for (const l of raw) {
    if (typeof l !== "object" || l === null) continue;
    const o = l as { polygon?: unknown; bbox?: unknown; text?: unknown; score?: unknown };
    if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || typeof o.text !== "string") continue;
    const bbox = o.bbox.map(Number) as [number, number, number, number];
    if (bbox.some((v) => !Number.isFinite(v))) continue;
    const polygon = Array.isArray(o.polygon)
      ? o.polygon
        .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2)
        .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
      : [];
    out.push({ polygon, bbox, text: o.text, score: typeof o.score === "number" ? o.score : 0 });
  }
  return out;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("sidecar baseUrl must be a valid HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("sidecar baseUrl must be an HTTP(S) URL without credentials");
  }
  if (url.search || url.hash) throw new Error("sidecar baseUrl must not contain a query or fragment");
  return url.toString().replace(/\/+$/, "");
}
