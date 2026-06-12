/**
 * Web Audio API による効果音合成。
 * AudioContext はユーザー操作後に自動初期化される。
 */

let _ctx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!_ctx) _ctx = new AudioContext();
  if (_ctx.state === "suspended") void _ctx.resume();
  return _ctx;
}

function beep(
  ac: AudioContext,
  t: number,
  freq: number,
  duration: number,
  volume: number,
  type: OscillatorType = "sine",
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.start(t);
  osc.stop(t + duration + 0.01);
}

/** ピピピ: detect フェーズ開始の 3 連ビープ */
export function playPipipi(): void {
  const ac = ctx();
  const now = ac.currentTime;
  for (let i = 0; i < 3; i++) {
    beep(ac, now + i * 0.13, 880, 0.065, 0.15, "square");
  }
}

/** analyze 再スキャン pass ごとの短いピップ */
export function playAnalysisPip(): void {
  const ac = ctx();
  beep(ac, ac.currentTime, 440, 0.04, 0.05, "sine");
}

/** ポーン: result フェーズの CONFIRMED チャイム */
export function playPon(): void {
  const ac = ctx();
  const now = ac.currentTime;
  // メイントーン: C6 → G5 グライド
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(1046, now);
  osc.frequency.exponentialRampToValueAtTime(784, now + 0.5);
  gain.gain.setValueAtTime(0.28, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  osc.start(now);
  osc.stop(now + 0.71);
  // シマー倍音: C7
  beep(ac, now, 2093, 0.15, 0.07, "sine");
}

/** 決定機械音: confirm フェーズでフィールドロック時 */
export function playKettei(): void {
  const ac = ctx();
  const t = ac.currentTime;
  // クリック: 短い square tick
  beep(ac, t, 1400, 0.03, 0.1, "square");
  // チャープ: 下降 sine
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, t + 0.025);
  osc.frequency.exponentialRampToValueAtTime(660, t + 0.14);
  gain.gain.setValueAtTime(0, t + 0.025);
  gain.gain.linearRampToValueAtTime(0.12, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  osc.start(t + 0.025);
  osc.stop(t + 0.15);
}

/** SCAN COMPLETE: confirm 完了後のアルペジオ */
export function playScanComplete(): void {
  const ac = ctx();
  const now = ac.currentTime;
  // C5 → E5 → G5 → C6
  [523, 659, 784, 1046].forEach((freq, i) => {
    beep(ac, now + i * 0.09, freq, 0.2, 0.12, "sine");
  });
}
