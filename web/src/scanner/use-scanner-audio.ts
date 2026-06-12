import { useEffect, useRef } from "react";
import {
  playPipipi,
  playAnalysisPip,
  playPon,
  playKettei,
  playScanComplete,
} from "./scanner-audio.js";
import type { DetectedRegion, ScanPhase } from "./types.js";

interface AudioInput {
  phase: ScanPhase;
  animated: boolean;
  rescanPass: number;
  confirmDone: boolean;
  regions: DetectedRegion[];
}

export function useScannerAudio({
  phase,
  animated,
  rescanPass,
  confirmDone,
  regions,
}: AudioInput): void {
  const prevPhaseRef = useRef<ScanPhase>("idle");
  const ketteiScheduledRef = useRef(false);

  // フェーズ遷移の効果音
  useEffect(() => {
    if (!animated) return;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase === "detect" && prev === "idle") {
      playPipipi();
    }
    if (phase === "result" && prev !== "result") {
      // CSS の animationDelay (700ms) に合わせてスタンプと同時に鳴らす
      const t = window.setTimeout(() => playPon(), 700);
      return () => window.clearTimeout(t);
    }
    if (phase !== "confirm") {
      ketteiScheduledRef.current = false;
    }
  }, [phase, animated]);

  // analyze 再スキャン pass ごとのピップ
  useEffect(() => {
    if (!animated || phase !== "analyze" || rescanPass === 0) return;
    playAnalysisPip();
  }, [rescanPass, animated, phase]);

  // confirm フィールド決定音: 各フィールドの delay に合わせてスケジュール
  useEffect(() => {
    if (!animated || phase !== "confirm" || ketteiScheduledRef.current) return;
    ketteiScheduledRef.current = true;
    const timers = regions
      .filter((r) => r.kind !== "noise")
      .map((r) => window.setTimeout(() => playKettei(), r.delay ?? 0));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phase, regions, animated]);

  // SCAN COMPLETE アルペジオ
  useEffect(() => {
    if (!animated || !confirmDone) return;
    playScanComplete();
  }, [confirmDone, animated]);
}
