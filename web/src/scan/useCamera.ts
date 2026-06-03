import { useEffect, useRef, useState } from "react";

/**
 * 環境カメラ (背面) を <video> に流すだけの hook。
 * 手動シャッター / AR スキャナ 両モードで共有する。
 * 返す videoRef を <video> に挿すと自動で getUserMedia + play する。
 */
export function useCamera(opts: { width?: number; height?: number } = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: opts.width ?? 1920 },
            height: { ideal: opts.height ?? 1080 },
          },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setRunning(true);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setRunning(false);
    };
    // width/height は初期化時のみ参照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { videoRef, running, error };
}
