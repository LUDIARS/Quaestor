import { useEffect, useRef, useState } from "react";
import {
  detectReceiptCandidates,
  StableDetectionTracker,
  type ReceiptCandidate,
} from "../../../src/detection/receipt-detector.js";

interface DetectionState {
  candidate: ReceiptCandidate | null;
  stable: boolean;
  fps: number;
  threshold: number;
}

interface CaptureState {
  receipt_id: string;
  image_url: string;
  size: number;
}

export function Scan() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectionState>({
    candidate: null, stable: false, fps: 0, threshold: 0,
  });
  const [running, setRunning] = useState(false);
  const [lastCapture, setLastCapture] = useState<CaptureState | null>(null);
  const [posting, setPosting] = useState(false);

  // detection loop の handle と tracker は ref で持つ (state にすると再 render で reset)
  const trackerRef = useRef(new StableDetectionTracker(5, 0.6, 0.55));
  const captureCooldownRef = useRef(0);

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

      // 検出用 low-res canvas (毎ループ作り直すのは無駄なので持ち回す)
      const low = ensureWorkCanvas(vw, vh);
      const ctx = low.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const targetW = low.targetW;
      const targetH = low.targetH;
      ctx.drawImage(video, 0, 0, targetW, targetH);
      const imgData = ctx.getImageData(0, 0, targetW, targetH);

      const cands = detectReceiptCandidates(imgData.data as unknown as Uint8Array, targetW, targetH, {
        maxDim: Math.max(targetW, targetH),  // 既に縮小済なので追加縮小なし
      });
      const top = cands[0] ?? null;

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
      const now = performance.now();
      if (now - fpsSampleAt > 500) {
        const fps = (frameCount * 1000) / (now - fpsSampleAt);
        frameCount = 0;
        fpsSampleAt = now;
        setDetection({
          candidate: native,
          stable: tres.stable,
          fps,
          threshold: top?.meta.threshold ?? 0,
        });
      }

      // 安定確定 → HD キャプチャ + POST。 連続発火を防ぐため 3 秒 cooldown
      if (tres.stable && tres.candidate && now > captureCooldownRef.current) {
        captureCooldownRef.current = now + 3000;
        captureAndUpload(video, tres.candidate).catch((e) => {
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

  async function captureAndUpload(video: HTMLVideoElement, candidate: ReceiptCandidate) {
    setPosting(true);
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // フル解像度 capture canvas
      const cap = document.createElement("canvas");
      cap.width = vw;
      cap.height = vh;
      const cx = cap.getContext("2d");
      if (!cx) throw new Error("canvas 2d context unavailable");
      cx.drawImage(video, 0, 0, vw, vh);
      const blob = await new Promise<Blob | null>((resolve) =>
        cap.toBlob((b) => resolve(b), "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("toBlob failed");
      const buf = new Uint8Array(await blob.arrayBuffer());
      const b64 = btoa(String.fromCharCode(...buf));

      const geo = await tryGetGeo();

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
            video_w: vw,
            video_h: vh,
            bbox: { x: candidate.x, y: candidate.y, w: candidate.width, h: candidate.height },
            score: candidate.score,
            detector_meta: candidate.meta,
          },
        }),
      });
      if (!res.ok) throw new Error(`POST /v1/receipts ${res.status}`);
      const j = (await res.json()) as { receipt: { id: string }; stored_size: number };
      setLastCapture({
        receipt_id: j.receipt.id,
        image_url: `/v1/receipts/${j.receipt.id}/image`,
        size: j.stored_size,
      });
    } finally {
      setPosting(false);
    }
  }

  return (
    <div>
      <h2>AR レシートスキャナ</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        カメラを許可して、 レシート (白い縦長矩形) をプレビュー枠の中央に映してください。
        <strong> 緑枠</strong> になったら自動キャプチャ → backend に POST 。
      </p>
      <div className="scan-stage">
        <video ref={videoRef} muted playsInline />
        <canvas ref={overlayRef} />
      </div>
      <div className="scan-meta">
        {error ? <span className="error">{error}</span> : null}
        {!error && (
          <>
            running: {running ? "yes" : "no"} ｜ fps: {detection.fps.toFixed(1)} ｜ otsu: {detection.threshold} ｜
            score: {detection.candidate ? detection.candidate.score.toFixed(2) : "-"} ｜
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
