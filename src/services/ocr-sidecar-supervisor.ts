/**
 * OCR sidecar (PaddleOCR microservice) のスーパーバイザ。
 *
 * Quaestor backend 起動時に sidecar (uvicorn) を子プロセスとして同時起動し、
 * クラッシュ時は backoff 付きで再起動する。ローカルアプリ前提 (sidecar 常駐が許容)。
 *
 *  - python は ocr-sidecar/.venv を優先、無ければ PATH の python/python3。
 *  - 子の stdout/stderr は **ファイル fd** に向ける (親死亡時 EPIPE を避ける)。
 *  - 依存未導入で連続失敗したら諦めて「ocr-sidecar/setup を実行」と案内。
 *
 * 無効化: QUAESTOR_OCR_SIDECAR_MANAGE=0
 * 外部 sidecar を使う場合は QUAESTOR_OCR_SIDECAR_URL を設定し、本機は起動しない。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface SidecarSupervisorOptions {
  /** sidecar ディレクトリ。既定 <cwd>/ocr-sidecar */
  sidecarDir?: string;
  host?: string;
  port?: number;
  /** ログ出力先。既定 app_data/ocr-sidecar.log */
  logFile?: string;
  /** 連続クラッシュの再起動上限。既定 5 */
  maxRestarts?: number;
  logger?: Logger;
}

function venvPython(dir: string): string | null {
  const win = join(dir, ".venv", "Scripts", "python.exe");
  const nix = join(dir, ".venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(nix)) return nix;
  return null;
}

export class OcrSidecarSupervisor {
  private readonly dir: string;
  private readonly host: string;
  private readonly port: number;
  private readonly logFile: string;
  private readonly maxRestarts: number;
  private readonly log: Logger;

  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private stableTimer: NodeJS.Timeout | null = null;

  constructor(opts: SidecarSupervisorOptions = {}) {
    this.dir = resolve(opts.sidecarDir ?? "ocr-sidecar");
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? Number(process.env.QUAESTOR_OCR_SIDECAR_PORT ?? 17350);
    this.logFile = resolve(opts.logFile ?? "app_data/ocr-sidecar.log");
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.log = opts.logger ?? { info: () => {}, warn: () => {} };
  }

  start(): void {
    if (this.stopped) return;
    if (!existsSync(join(this.dir, "main.py"))) {
      this.log.warn({ dir: this.dir }, "ocr sidecar dir not found; skipped");
      return;
    }
    const py = venvPython(this.dir) ?? process.env.QUAESTOR_OCR_PYTHON ?? defaultPython();
    this.spawnChild(py, venvPython(this.dir) == null);
  }

  private spawnChild(python: string, noVenv: boolean): void {
    mkdirSync(dirname(this.logFile), { recursive: true });
    const fd = openSync(this.logFile, "a");

    let child: ChildProcess;
    try {
      child = spawn(
        python,
        ["-m", "uvicorn", "main:app", "--host", this.host, "--port", String(this.port)],
        { cwd: this.dir, stdio: ["ignore", fd, fd], env: { ...process.env } },
      );
    } catch (e: unknown) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "ocr sidecar spawn failed");
      return;
    }
    this.child = child;
    this.log.info({ pid: child.pid, port: this.port, python, noVenv }, "ocr sidecar starting");

    // 15 秒安定したら restart カウンタをリセット
    this.stableTimer = setTimeout(() => { this.restarts = 0; }, 15_000);

    child.once("error", (err) => {
      this.log.warn({ err: err.message }, "ocr sidecar process error");
    });
    child.on("exit", (code, signal) => {
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      this.child = null;
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) {
        this.log.warn(
          { logFile: this.logFile },
          noVenv
            ? "ocr sidecar が連続終了。 ocr-sidecar/setup で venv+依存を用意してください"
            : "ocr sidecar が連続終了。 app_data/ocr-sidecar.log を確認してください",
        );
        return;
      }
      this.restarts += 1;
      const backoff = Math.min(30_000, 1000 * 2 ** this.restarts);
      this.log.warn({ code, signal, restarts: this.restarts, backoffMs: backoff }, "ocr sidecar exited; restarting");
      setTimeout(() => { if (!this.stopped) this.spawnChild(python, noVenv); }, backoff);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
    this.child = null;
  }
}

function defaultPython(): string {
  return process.platform === "win32" ? "python" : "python3";
}
