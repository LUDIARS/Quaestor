/**
 * アプリ設定の単一 loader (AIFormat RULE.md §7.1)。
 *
 * 環境統合系の設定値 (host/port/パス/機能フラグ/間隔) は、リポ管理の
 * `quaestor.config.json` を正本として読む。環境変数は **override のみ**
 * (既定値はファイル)。「手元だけ env を立てれば動く」状態を作らない。
 *
 * シークレットはここに置かない — secret-store.ts (暗号化ストア) が担当。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  server: {
    host: string;
    port: number;
    logLevel: string;
  };
  web: {
    /** Vite dev server の allowedHosts (外部ホスト)。localhost / 127.0.0.1 は常に許可。 */
    allowedHosts: string[];
  };
  storage: {
    dbPath: string;
    receiptsRoot: string;
  };
  ocrWorker: {
    enabled: boolean;
    intervalMs: number;
  };
  ocrSidecar: {
    /** Quaestor が sidecar を子プロセスとして同時起動するか */
    manage: boolean;
    host: string;
    port: number;
    /** PaddleOCR 言語 (sidecar へ渡す) */
    lang: string;
    /** python 実行体の明示指定 (null = .venv 優先 → PATH) */
    python: string | null;
    /**
     * .venv を「作る」ときに使う python (setup.ps1/sh が読む)。
     * paddlepaddle は 3.9〜3.12 のみ wheel 提供のため、PATH 任せにせず固定できる。
     * null = setup スクリプトが 3.12→3.9 を自動探索。
     */
    venvPython: string | null;
    /** 外部 sidecar URL (指定時は manage を無視して起動しない) */
    externalUrl: string | null;
  };
  training: {
    gaRoot: string;
  };
  /** 請求書の公開マジックリンク (spec/feature/invoice-public-magic-link.md) */
  invoiceShare: {
    /** 公開 HTTPS origin (path/query/fragment/credential 不可)。 null = リンク発行不可 */
    publicUrl: string | null;
    /** 共有を許可する PDF ルート。 相対はプロセス CWD 基準 */
    roots: string[];
  };
  /** 補助金の定期クロール (#278)。 */
  subsidyCrawl: {
    enabled: boolean;       // master switch (既定 false)
    intervalMs: number;     // 既定 24h
    keywords: string[];     // クロール対象キーワード
    perKeywordLimit: number; // 1 キーワードあたりの取込上限 (既定 10)
  };
  /** 定期 Discord 通知 (アドバイザーのアドバイス push)。 webhook URL はシークレット側 */
  notifications: {
    enabled: boolean;        // 定期 worker の master switch (既定 false)
    intervalMs: number;      // 既定 6 時間
    invest: boolean;         // 投資/優待アドバイス
    portfolio: boolean;      // 配当アドバイス
    subsidies: { enabled: boolean; planId: string | null }; // 補助金は crawl+LLM が走るので既定 off
  };
}

const DEFAULTS: AppConfig = {
  server:  { host: "127.0.0.1", port: 17400, logLevel: "info" },
  web: { allowedHosts: [] },
  storage: { dbPath: "app_data/quaestor.db", receiptsRoot: "app_data/receipts" },
  ocrWorker: { enabled: true, intervalMs: 30_000 },
  ocrSidecar: {
    manage: true, host: "127.0.0.1", port: 17350,
    lang: "japan", python: null, venvPython: null, externalUrl: null,
  },
  training: { gaRoot: "app_data/training/ga" },
  invoiceShare: { publicUrl: null, roots: ["data", "app_data/invoices"] },
  subsidyCrawl: {
    enabled: false,
    intervalMs: 86_400_000,   // 24h
    keywords: ["創業", "補助金", "助成金", "小規模事業者"],
    perKeywordLimit: 10,
  },
  notifications: {
    enabled: false,
    intervalMs: 21_600_000, // 6h
    invest: true,
    portfolio: true,
    subsidies: { enabled: false, planId: null },
  },
};

/**
 * quaestor.config.json → env override → 既定値 の順で解決する。
 * ファイルが無い/壊れている場合は既定値で動く (起動は止めない)。
 */
export function loadAppConfig(file = "quaestor.config.json"): AppConfig {
  const fromFile = readConfigFile(resolve(file));
  const c: AppConfig = {
    server: {
      host:     str(env("QUAESTOR_HOST"),      fromFile?.server?.host,     DEFAULTS.server.host),
      port:     num(env("QUAESTOR_PORT"),      fromFile?.server?.port,     DEFAULTS.server.port),
      logLevel: str(env("QUAESTOR_LOG_LEVEL"), fromFile?.server?.logLevel, DEFAULTS.server.logLevel),
    },
    storage: {
      dbPath:       str(env("QUAESTOR_DB"),            fromFile?.storage?.dbPath,       DEFAULTS.storage.dbPath),
      receiptsRoot: str(env("QUAESTOR_RECEIPTS_ROOT"), fromFile?.storage?.receiptsRoot, DEFAULTS.storage.receiptsRoot),
    },
    ocrWorker: {
      enabled:    flag(env("QUAESTOR_OCR_WORKER"),         fromFile?.ocrWorker?.enabled,    DEFAULTS.ocrWorker.enabled),
      intervalMs: num(env("QUAESTOR_OCR_INTERVAL_MS"),     fromFile?.ocrWorker?.intervalMs, DEFAULTS.ocrWorker.intervalMs),
    },
    ocrSidecar: {
      manage: flag(env("QUAESTOR_OCR_SIDECAR_MANAGE"), fromFile?.ocrSidecar?.manage, DEFAULTS.ocrSidecar.manage),
      host:   str(undefined,                            fromFile?.ocrSidecar?.host,  DEFAULTS.ocrSidecar.host),
      port:   num(env("QUAESTOR_OCR_SIDECAR_PORT"),    fromFile?.ocrSidecar?.port,   DEFAULTS.ocrSidecar.port),
      lang:   str(env("QUAESTOR_OCR_LANG"),            fromFile?.ocrSidecar?.lang,   DEFAULTS.ocrSidecar.lang),
      python: strOrNull(env("QUAESTOR_OCR_PYTHON"),    fromFile?.ocrSidecar?.python),
      venvPython: strOrNull(undefined,                 fromFile?.ocrSidecar?.venvPython),
      externalUrl: strOrNull(env("QUAESTOR_OCR_SIDECAR_URL"), fromFile?.ocrSidecar?.externalUrl),
    },
    training: {
      gaRoot: str(undefined, fromFile?.training?.gaRoot, DEFAULTS.training.gaRoot),
    },
    invoiceShare: {
      publicUrl: strOrNull(env("QUAESTOR_PUBLIC_URL"), fromFile?.invoiceShare?.publicUrl),
      roots: semicolonList(env("QUAESTOR_INVOICE_SHARE_ROOTS"))
        ?? arr(fromFile?.invoiceShare?.roots, DEFAULTS.invoiceShare.roots),
    },
    subsidyCrawl: {
      enabled:         flag(env("QUAESTOR_SUBSIDY_CRAWL"),          fromFile?.subsidyCrawl?.enabled,         DEFAULTS.subsidyCrawl.enabled),
      intervalMs:      num(env("QUAESTOR_SUBSIDY_CRAWL_INTERVAL_MS"), fromFile?.subsidyCrawl?.intervalMs,    DEFAULTS.subsidyCrawl.intervalMs),
      keywords:        arr(fromFile?.subsidyCrawl?.keywords,         DEFAULTS.subsidyCrawl.keywords),
      perKeywordLimit: num(env("QUAESTOR_SUBSIDY_CRAWL_LIMIT"),      fromFile?.subsidyCrawl?.perKeywordLimit, DEFAULTS.subsidyCrawl.perKeywordLimit),
    },
    notifications: {
      enabled:    flag(env("QUAESTOR_NOTIFY"),             fromFile?.notifications?.enabled,    DEFAULTS.notifications.enabled),
      intervalMs: num(env("QUAESTOR_NOTIFY_INTERVAL_MS"),  fromFile?.notifications?.intervalMs, DEFAULTS.notifications.intervalMs),
      invest:     flag(undefined,                          fromFile?.notifications?.invest,     DEFAULTS.notifications.invest),
      portfolio:  flag(undefined,                          fromFile?.notifications?.portfolio,  DEFAULTS.notifications.portfolio),
      subsidies: {
        enabled: flag(undefined, fromFile?.notifications?.subsidies?.enabled, DEFAULTS.notifications.subsidies.enabled),
        planId:  strOrNull(env("QUAESTOR_NOTIFY_SUBSIDY_PLAN"), fromFile?.notifications?.subsidies?.planId),
      },
    },
    web: {
      allowedHosts: arr(fromFile?.web?.allowedHosts, DEFAULTS.web.allowedHosts),
    },
  };
  return c;
}

/** sidecar の実効 URL (外部指定があればそれ、無ければ自前管理分) */
export function sidecarUrlOf(c: AppConfig): string {
  return c.ocrSidecar.externalUrl ?? `http://${c.ocrSidecar.host}:${c.ocrSidecar.port}`;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** 設定ファイルの部分型 (欠けたキーは既定値で補完) */
type PartialConfig = {
  server?: Partial<AppConfig["server"]>;
  storage?: Partial<AppConfig["storage"]>;
  ocrWorker?: Partial<AppConfig["ocrWorker"]>;
  subsidyCrawl?: Partial<AppConfig["subsidyCrawl"]>;
  ocrSidecar?: Partial<AppConfig["ocrSidecar"]>;
  training?: Partial<AppConfig["training"]>;
  invoiceShare?: Partial<AppConfig["invoiceShare"]>;
  notifications?: Partial<Omit<AppConfig["notifications"], "subsidies">> & {
    subsidies?: Partial<AppConfig["notifications"]["subsidies"]>;
  };
  web?: Partial<AppConfig["web"]>;
};

function readConfigFile(path: string): PartialConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialConfig;
  } catch {
    return null; // 壊れた設定で起動を止めない (既定値で動く)
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function str(envVal: string | undefined, fileVal: string | undefined | null, def: string): string {
  return envVal ?? (fileVal ?? undefined) ?? def;
}

function strOrNull(envVal: string | undefined, fileVal: string | undefined | null): string | null {
  return envVal ?? fileVal ?? null;
}

function num(envVal: string | undefined, fileVal: number | undefined | null, def: number): number {
  if (envVal !== undefined) {
    const n = Number(envVal);
    if (Number.isFinite(n)) return n;
  }
  return fileVal ?? def;
}

/** env は "0"/"false" を false、それ以外を true。ファイルは boolean そのまま */
function flag(envVal: string | undefined, fileVal: boolean | undefined | null, def: boolean): boolean {
  if (envVal !== undefined) return envVal !== "0" && envVal.toLowerCase() !== "false";
  return fileVal ?? def;
}

/** env の ";" 区切りリスト。 未指定/空なら undefined (= ファイル/既定値へ委譲) */
function semicolonList(envVal: string | undefined): string[] | undefined {
  if (envVal === undefined) return undefined;
  const items = envVal.split(";").map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function arr(fileVal: string[] | undefined | null, def: string[]): string[] {
  if (Array.isArray(fileVal)) return fileVal.filter((v): v is string => typeof v === "string");
  return def;
}
