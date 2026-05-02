import { useEffect, useRef, useState } from "react";
import {
  detectReceiptCandidates,
  extractDebug,
  StableDetectionTracker,
  type ReceiptCandidate,
} from "../../../src/detection/receipt-detector.js";

interface DetectionState {
  candidate: ReceiptCandidate | null;
  stable: boolean;
  fps: number;
  threshold: number;
  parallelism: number;
}

interface CaptureState {
  receipt_id: string;
  image_url: string;
  size: number;
}

interface SpecStats {
  sent: number;
  deduped: number;
  inserted: number;
}

export function Scan() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const debugRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectionState>({
    candidate: null, stable: false, fps: 0, threshold: 234, parallelism: 0,
  });
  // 白判定閾値: 1 秒に 1 ずつ下げる、 floor 180、 stable で 234 にリセット
  const whiteThresholdRef = useRef(234);
  const lastDecayAtRef = useRef(performance.now());
  const [running, setRunning] = useState(false);
  const [lastCapture, setLastCapture] = useState<CaptureState | null>(null);
  const [posting, setPosting] = useState(false);
  const [specStats, setSpecStats] = useState<SpecStats>({ sent: 0, deduped: 0, inserted: 0 });
  const specStatsRef = useRef<SpecStats>({ sent: 0, deduped: 0, inserted: 0 });

  // detection loop の handle と tracker は ref で持つ (state にすると再 render で reset)
  const trackerRef = useRef(new StableDetectionTracker(5, 0.6, 0.55));
  const captureCooldownRef = useRef(0);
  // 投機的実行: 白枠検出した瞬間に高解像度キャプチャ → POST。 サーバ側 dedupe で 2 回目以降は無視。
  const speculativeCooldownRef = useRef(0);
  const lastSpeculativeHashRef = useRef<string>("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    let frameCount = 0;
    let fpsSampleAt = performance.now();

    async function setup() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setRunning(true);
        loop();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    function loop() {
      if (cancelled) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay || video.readyState < 2 || video.videoWidth === 0) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const now = performance.now();

      // 検出用 low-res canvas (毎ループ作り直すのは無駄なので持ち回す)
      const low = ensureWorkCanvas(vw, vh);
      const ctx = low.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const targetW = low.targetW;
      const targetH = low.targetH;
      ctx.drawImage(video, 0, 0, targetW, targetH);
      const imgData = ctx.getImageData(0, 0, targetW, targetH);

      // 1 秒毎に whiteThreshold を 1 ずつ下げる (検出無し時)。 stable 検出が出たら 234 にリセット
      if (now - lastDecayAtRef.current > 1000) {
        if (whiteThresholdRef.current > 180) whiteThresholdRef.current -= 1;
        lastDecayAtRef.current = now;
      }

      const cands = detectReceiptCandidates(imgData.data as unknown as Uint8Array, targetW, targetH, {
        maxDim: Math.max(targetW, targetH),  // 既に縮小済なので追加縮小なし
        returnDebug: true,
        whiteThreshold: whiteThresholdRef.current,
      });
      const top = cands[0] ?? null;
      // 候補が出た瞬間に decay timer を緩める (大きく下げ過ぎないため)
      if (top && top.score >= 0.5) {
        lastDecayAtRef.current = now;
      }

      // debug プレビュー: white mask + edge map を別 canvas に合成描画
      const dbg = extractDebug(cands as ReceiptCandidate[] & { __debug?: import("../../../src/detection/receipt-detector.js").DetectorDebug });
      const debugCanvas = debugRef.current;
      if (dbg && debugCanvas) {
        if (debugCanvas.width !== dbg.width || debugCanvas.height !== dbg.height) {
          debugCanvas.width = dbg.width;
          debugCanvas.height = dbg.height;
        }
        const dctx = debugCanvas.getContext("2d");
        if (dctx) {
          const out = dctx.createImageData(dbg.width, dbg.height);
          for (let i = 0; i < dbg.gray.length; i++) {
            const m = dbg.mask[i] ?? 0;
            const e = dbg.edge[i] ?? 0;
            const g = dbg.gray[i] ?? 0;
            let r = 0, gr = 0, b = 0;
            if (m === 2) { r = 60; gr = 220; b = 100; }       // detected component (緑)
            else if (m === 1) { r = 100; gr = 160; b = 250; } // 白 (青)
            else { r = gr = b = Math.floor(g * 0.4); }        // 背景 (暗グレー)
            // edge 強度を赤 channel に上乗せ (色差分境界が ハイライトされる)
            if (e > 50) {
              const boost = Math.min(255, e * 2);
              r = Math.min(255, r + boost);
              gr = Math.max(0, gr - 30);
              b = Math.max(0, b - 30);
            }
            const j = i * 4;
            out.data[j] = r;
            out.data[j + 1] = gr;
            out.data[j + 2] = b;
            out.data[j + 3] = 255;
          }
          dctx.putImageData(out, 0, 0);
        }
      }

      // tracker (元画像 native 解像度に合わせて bbox を返却するよう candidate を補正)
      const native = top
        ? {
            ...top,
            x: Math.round((top.x / targetW) * vw),
            y: Math.round((top.y / targetH) * vh),
            width: Math.round((top.width / targetW) * vw),
            height: Math.round((top.height / targetH) * vh),
          }
        : null;
      const tres = trackerRef.current.push(native);

      // overlay 描画 (video の表示サイズ = native 解像度)
      overlay.width = vw;
      overlay.height = vh;
      const ox = overlay.getContext("2d");
      if (ox) {
        ox.clearRect(0, 0, vw, vh);
        if (native) {
          ox.lineWidth = Math.max(2, Math.round(vw / 200));
          ox.strokeStyle = tres.stable ? "#51cf66" : "#4dabf7";
          ox.strokeRect(native.x, native.y, native.width, native.height);
          ox.font = `${Math.round(vw / 40)}px ui-monospace, monospace`;
          ox.fillStyle = ox.strokeStyle;
          ox.fillText(`score ${native.score.toFixed(2)}`, native.x + 4, native.y - 6);
        }
      }

      // FPS 計測
      frameCount++;
      if (now - fpsSampleAt > 500) {
        const fps = (frameCount * 1000) / (now - fpsSampleAt);
        frameCount = 0;
        fpsSampleAt = now;
        setDetection({
          candidate: native,
          stable: tres.stable,
          fps,
          threshold: whiteThresholdRef.current,
          parallelism: top?.meta.parallelismScore ?? 0,
        });
      }

      // 投機的実行: score >= 0.5 の白枠候補があれば 300ms 間隔で即キャプチャ → POST
      // サーバ側で dedup hash により同じ画像は無視される (重複は 2 回目以降を捨てる)
      if (native && native.score >= 0.5 && now > speculativeCooldownRef.current) {
        speculativeCooldownRef.current = now + 300;
        const bbox = native;
        captureAndUpload(video, bbox, "speculative").catch((e) => {
          console.warn("[scan] speculative upload failed:", e);
        });
      }
      // stable 確定もそのまま保持: 確定キャプチャは 3 秒 cooldown で 1 件 + 閾値リセット
      if (tres.stable && tres.candidate && now > captureCooldownRef.current) {
        captureCooldownRef.current = now + 3000;
        whiteThresholdRef.current = 234;  // reset on success
        captureAndUpload(video, tres.candidate, "stable").catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      }
    }

    setup();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setRunning(false);
    };
  }, []);

  async function captureAndUpload(video: HTMLVideoElement, candidate: ReceiptCandidate, kind: "stable" | "speculative") {
    if (kind === "stable") setPosting(true);
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // 投機実行は中解像度 (max 1024 辺) に縮めて転送量を抑える
      const maxDim = kind === "speculative" ? 1024 : Math.max(vw, vh);
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
        cap.toBlob((b) => resolve(b), "image/jpeg", kind === "speculative" ? 0.7 : 0.92),
      );
      if (!blob) throw new Error("toBlob failed");
      const buf = new Uint8Array(await blob.arrayBuffer());
      // 簡易 hash (投機実行 局所 dedup): bbox + score quanta + フレーム特徴。 同フレーム再送防止
      const hashSeed = `${candidate.x}|${candidate.y}|${Math.round(candidate.score * 20)}|${buf.length >> 8}`;
      if (kind === "speculative" && hashSeed === lastSpeculativeHashRef.current) return;
      lastSpeculativeHashRef.current = hashSeed;

      const b64 = btoa(String.fromCharCode(...buf));
      const geo = kind === "stable" ? await tryGetGeo() : null;

      if (kind === "speculative") {
        specStatsRef.current.sent++;
      }
      const res = await fetch("/v1/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image_b64: b64,
          ext: "jpg",
          captured_at: Math.floor(Date.now() / 1000),
          geo,
          metadata: {
            source: "ar-scanner",
            kind,
            video_w: vw,
            video_h: vh,
            captured_w: cw,
            captured_h: ch,
            bbox: { x: candidate.x, y: candidate.y, w: candidate.width, h: candidate.height },
            score: candidate.score,
            detector_meta: candidate.meta,
            client_hash: hashSeed,
          },
        }),
      });
      if (!res.ok) throw new Error(`POST /v1/receipts ${res.status}`);
      const j = (await res.json()) as {
        receipt: { id: string };
        stored_size: number;
        deduped?: boolean;
      };
      if (kind === "speculative") {
        if (j.deduped) specStatsRef.current.deduped++;
        else specStatsRef.current.inserted++;
        setSpecStats({ ...specStatsRef.current });
      }
      // server-side dedup によって既存 receipt が返ったら state 更新は最後勝ち
      // 但し investitive (kind=stable) でない speculative の dedup 結果は state 上書きしない
      if (kind === "stable" || !j.deduped) {
        setLastCapture({
          receipt_id: j.receipt.id,
          image_url: `/v1/receipts/${j.receipt.id}/image`,
          size: j.stored_size,
        });
      }
    } finally {
      if (kind === "stable") setPosting(false);
    }
  }

  return (
    <div>
      <h2>AR レシートスキャナ</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        カメラを許可して、 レシート (白い縦長矩形) をプレビュー枠の中央に映してください。
        <strong> 緑枠</strong> になったら自動キャプチャ → backend に POST 。
      </p>
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="scan-stage">
          <video ref={videoRef} muted playsInline />
          <canvas ref={overlayRef} />
        </div>
        <div style={{ minWidth: 160 }}>
          <div className="text-xs text-subtle mb-1">検出ビュー (二値化 + 連結成分)</div>
          <canvas
            ref={debugRef}
            style={{
              width: 192,
              height: 384,
              imageRendering: "pixelated",
              border: "1px solid var(--c-border)",
              borderRadius: 4,
              background: "var(--c-bg)",
            }}
          />
          <div className="text-xs text-subtle mt-2 mb-1">検出スコア</div>
          <ScoreGauge value={detection.candidate?.score ?? 0} stable={detection.stable} />
          <div className="text-xs text-subtle mt-3">
            投機キャプチャ:<br />
            送信 <strong className="text-text">{specStats.sent}</strong>{" "}
            / 採用 <strong className="text-ok">{specStats.inserted}</strong>{" "}
            / 重複 <strong className="text-subtle">{specStats.deduped}</strong>
          </div>
        </div>
      </div>
      <div className="scan-meta">
        {error ? <span className="error">{error}</span> : null}
        {!error && (
          <>
            running: {running ? "yes" : "no"} ｜ fps: {detection.fps.toFixed(1)} ｜
            white≥<strong style={{ color: "var(--c-accent)" }}>{detection.threshold}</strong> (1s毎-1) ｜
            score: {detection.candidate ? detection.candidate.score.toFixed(2) : "-"} ｜
            ‖ {detection.parallelism.toFixed(2)} ｜
            {detection.stable ? <span className="stable">STABLE</span> : "tracking"}
            {posting ? " ｜ posting…" : null}
          </>
        )}
      </div>
      {lastCapture && (
        <div className="last-capture">
          last capture: <code>{lastCapture.receipt_id}</code> ({lastCapture.size.toLocaleString()} bytes)
          <br />
          <img src={lastCapture.image_url} alt="captured receipt" />
        </div>
      )}
    </div>
  );
}

/**
 * ループの間で持ち回す low-res 作業 canvas。 video 解像度から最大辺 256 を保つよう scale を計算。
 */
const work: { canvas: HTMLCanvasElement | null; targetW: number; targetH: number } = {
  canvas: null, targetW: 0, targetH: 0,
};
function ensureWorkCanvas(vw: number, vh: number): { canvas: HTMLCanvasElement; targetW: number; targetH: number } {
  const MAX = 256;
  const scale = Math.min(1, MAX / Math.max(vw, vh));
  const tw = Math.round(vw * scale);
  const th = Math.round(vh * scale);
  if (!work.canvas) work.canvas = document.createElement("canvas");
  if (work.canvas.width !== tw || work.canvas.height !== th) {
    work.canvas.width = tw;
    work.canvas.height = th;
  }
  work.targetW = tw;
  work.targetH = th;
  return { canvas: work.canvas, targetW: tw, targetH: th };
}

function ScoreGauge({ value, stable }: { value: number; stable: boolean }) {
  const pct = Math.max(0, Math.min(1, value));
  const color = stable
    ? "var(--c-ok)"
    : pct >= 0.55
      ? "var(--c-accent)"
      : pct >= 0.35
        ? "var(--c-warn)"
        : "var(--c-danger)";
  return (
    <div style={{ width: 192 }}>
      <div
        style={{
          height: 14,
          background: "var(--c-muted)",
          borderRadius: 7,
          overflow: "hidden",
          border: "1px solid var(--c-border)",
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: "100%",
            background: color,
            transition: "width 80ms linear, background 200ms",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--c-subtle)", marginTop: 2 }}>
        <span>0</span>
        <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--c-text)" }}>
          {(pct * 100).toFixed(0)}%
        </span>
        <span>100</span>
      </div>
      {/* 0.5 と 0.85 の閾値ライン */}
      <div style={{ position: "relative", marginTop: -16, height: 14, pointerEvents: "none" }}>
        <div style={{ position: "absolute", left: "50%", top: -14, height: 14, borderLeft: "1px dashed var(--c-warn)" }} />
        <div style={{ position: "absolute", left: "85%", top: -14, height: 14, borderLeft: "1px dashed var(--c-ok)" }} />
      </div>
    </div>
  );
}

async function tryGetGeo(): Promise<{ lat: number; lon: number; accuracy?: number } | null> {
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
