/**
 * レシート撮影 → 保存 → OCR → 投入 の HTTP クライアント。
 *
 * 手動シャッター (ManualShutter) と AR スキャナ (ArScanner) で共有する。
 * UI に依存しない純関数の集合にして、 各モードは orchestration だけ持つ。
 */

export interface CapturedFrame {
  /** base64 (no data: prefix) */
  b64: string;
  bytes: number;
  /** キャプチャした実解像度 */
  w: number;
  h: number;
}

/**
 * <video> の現フレームを jpeg に焼いて base64 で返す。
 * maxDim で最大辺を縮小 (OCR は 720px 程度で十分)。
 */
export async function captureFrame(
  video: HTMLVideoElement,
  opts: { maxDim?: number; quality?: number } = {},
): Promise<CapturedFrame> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) throw new Error("video not ready");
  const maxDim = opts.maxDim ?? 1080;
  const quality = opts.quality ?? 0.9;
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const cw = Math.round(vw * scale);
  const ch = Math.round(vh * scale);

  const cap = document.createElement("canvas");
  cap.width = cw;
  cap.height = ch;
  const cx = cap.getContext("2d");
  if (!cx) throw new Error("canvas 2d context unavailable");
  cx.drawImage(video, 0, 0, cw, ch);
  const blob = await new Promise<Blob | null>((resolve) =>
    cap.toBlob((b) => resolve(b), "image/jpeg", quality),
  );
  if (!blob) throw new Error("toBlob failed");
  const buf = new Uint8Array(await blob.arrayBuffer());
  // btoa は引数長に上限があるため chunk 化
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return { b64: btoa(bin), bytes: buf.length, w: cw, h: ch };
}

export interface Geo {
  lat: number;
  lon: number;
  accuracy?: number;
}

export interface UploadedReceipt {
  receipt: {
    id: string;
    ocr_status: string;
    date: string | null;
    payee: string | null;
    total: number | null;
    committed_at?: number | null;
  };
  stored_size: number;
  deduped: boolean;
  auto_triggered?: boolean;
}

/** POST /v1/receipts — 画像を保存して pending エントリを作る (server 側で image-hash dedup)。 */
export async function uploadReceipt(body: {
  b64: string;
  ext?: "jpg" | "png";
  capturedAt?: number;
  geo?: Geo | null;
  metadata?: Record<string, unknown>;
}): Promise<UploadedReceipt> {
  const res = await fetch("/v1/receipts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      image_b64: body.b64,
      ext: body.ext ?? "jpg",
      captured_at: body.capturedAt ?? Math.floor(Date.now() / 1000),
      geo: body.geo ?? null,
      metadata: body.metadata ?? {},
    }),
  });
  if (!res.ok) throw new Error(`POST /v1/receipts ${res.status}`);
  return (await res.json()) as UploadedReceipt;
}

/**
 * OCR をキックする。 Anthropic SDK 経路 (sync) を優先、 503 (key 未設定) なら
 * Claude Code CLI 経路 (async) に fallback。 ReceiptQueue と同じ流儀。
 */
export async function kickOcr(id: string): Promise<void> {
  const res = await fetch(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
  if (res.status === 503) {
    await fetch(`/v1/receipts/${id}/ocr/claude-code`, { method: "POST" });
  }
}

/**
 * POST /v1/receipts/:id/detect — 勝ち遺伝子で 1 回だけ検出し、運用評価レコードを発行させる
 * (spec/feature/ocr-ga-evaluation.md SPEC-OCR-GA-EVAL-006)。
 *
 * OCR (真値) が揃ってから 1 撮影につき 1 回キックする。backend 側は 1 receipt = 1 本に畳み、
 * 評価済なら sidecar を叩き直さないので、演出側の locator が重ねて呼んでも二重にならない。
 * 応答 (CPU で 40 秒) は待たない — 演出は従来の fallback で進む。
 *
 * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
 */
export function kickDetect(id: string): void {
  void fetch(`/v1/receipts/${id}/detect`, { method: "POST" })
    .catch(() => { /* 検出の失敗は演出にも投入にも影響させない */ });
}

export type CommitResult =
  | { ok: true; already?: boolean; receipt: UploadedReceipt["receipt"] }
  | { ok: false; status: number; error: string; missing?: string[]; existing_id?: string; message?: string };

/** POST /v1/receipts/:id/commit — データ完備 + (日付-場所-金額) 重複判定の上で投入。 */
export async function commitReceipt(id: string): Promise<CommitResult> {
  const res = await fetch(`/v1/receipts/${id}/commit`, { method: "POST" });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, already: j.already, receipt: j.receipt };
  return {
    ok: false,
    status: res.status,
    error: j.error ?? `commit failed (${res.status})`,
    missing: j.missing,
    existing_id: j.existing_id,
    message: j.message,
  };
}

/**
 * POST /v1/receipts/:id/regions — confirm フェーズの本物 BB を学習データに保存。
 * source=real のみ server 側で採用。失敗は握り潰す (演出を止めない)。
 */
export async function saveRegions(
  id: string,
  payload: {
    engine: string;
    naturalWidth: number;
    naturalHeight: number;
    regions: Array<{
      label: string;
      x: number; y: number; width: number; height: number;
      recognizedText?: string;
      polygon?: Array<[number, number]>;
      confidence?: number;
      source?: "real" | "heuristic";
    }>;
  },
): Promise<void> {
  try {
    await fetch(`/v1/receipts/${id}/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* 学習データ保存失敗はユーザ体験に影響させない */ }
}

/** 端末位置情報 (任意)。 失敗・タイムアウトは null。 */
export async function tryGetGeo(): Promise<Geo | null> {
  if (!("geolocation" in navigator)) return null;
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(null), 1500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeoutId);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      () => { clearTimeout(timeoutId); resolve(null); },
      { enableHighAccuracy: false, timeout: 1500, maximumAge: 60_000 },
    );
  });
}
