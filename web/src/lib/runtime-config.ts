/**
 * backend 公開設定 (/v1/config) の取得 (AIFormat RULE.md §7.1)。
 *
 * web は import.meta.env (ビルド時 env) を使わない。非シークレット設定は
 * backend の quaestor.config.json が正本で、/v1/config 経由で受け取る。
 * 取得失敗時は既定値で動く (起動を止めない)。
 */

export interface RuntimeConfig {
  ocrSidecarUrl: string;
}

const DEFAULTS: RuntimeConfig = {
  ocrSidecarUrl: "http://127.0.0.1:17350",
};

let cached: Promise<RuntimeConfig> | null = null;

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  cached ??= fetch("/v1/config")
    .then(async (res) => {
      if (!res.ok) return DEFAULTS;
      const j = (await res.json()) as Partial<RuntimeConfig>;
      return { ...DEFAULTS, ...j };
    })
    .catch(() => DEFAULTS);
  return cached;
}

/** OCR sidecar の base URL */
export async function ocrSidecarUrl(): Promise<string> {
  return (await getRuntimeConfig()).ocrSidecarUrl;
}
