/**
 * Claude Code CLI (`claude -p`) を spawn してレシート画像を解析する OCR backend。
 *
 * @implements SPEC-RECEIPT-OCR-CLI-001 (spec/feature/receipt-ocr-claude-cli.md)
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-SCAN-KIND-002 (spec/feature/scan-document-kinds.md)
 *
 * Anthropic SDK 経由 (AnthropicOcrClient) と並ぶ別経路。 こちらは:
 *  - 機械的 API key 不要 (claude CLI 自身の auth を使う)
 *  - 解析は claude のサイドで行われる (multimodal Read で画像を視認)
 *  - 結果は claude が直接 PATCH /v1/receipts/:id/ocr で書き戻す
 *  - サーバはプロセスを起動 → fire-and-forget。 OCR 状態は status='processing' に
 *    遷移、 完了は claude の PATCH で 'done'/'manual'/'failed' に切り替わる
 */

import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { mkdirSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { classificationPromptSection } from "./ocr-classification-prompt.js";

export interface ClaudeCodeOcrOptions {
  backendBaseUrl: string;
  /** Windows で git-bash パス (claude CLI 必須)。 環境変数 CLAUDE_CODE_GIT_BASH_PATH と同じ */
  bashPath?: string;
  /** 起動時の cwd。 既定はプロジェクトルート */
  workingDir?: string;
  /** 子プロセス kill タイムアウト (ms)。 既定 180_000 (3 分) */
  timeoutMs?: number;
  /** ログ出力先ディレクトリ。 既定 app_data/claude-code-logs */
  logDir?: string;
  /**
   * `--model` に渡すモデル。 未指定だと CLI 既定のモデルに乗るため、
   * そのモデルの利用上限を対話セッション側で使い切っていると OCR まで巻き込まれて
   * 画像を見る前に exit する。 null / 未指定で CLI 既定に委ねる。
   */
  model?: string | null;
}

export interface CompleteEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  logFile: string;
  /** ログ末尾 4KB (要約用) */
  tail: string;
  durationMs: number;
}

export class ClaudeCodeOcr {
  private readonly logDir: string;

  constructor(private readonly opts: ClaudeCodeOcrOptions) {
    this.logDir = opts.logDir ?? resolve(opts.workingDir ?? process.cwd(), "app_data", "claude-code-logs");
    mkdirSync(this.logDir, { recursive: true });
  }

  logPath(receiptId: string): string {
    return join(this.logDir, `${receiptId}.log`);
  }

  /**
   * Fire-and-forget で claude を起動。 子プロセスの stdout/stderr は logFile に追記、
   * exit 時に onComplete callback が呼ばれる (DB 反映等は呼び出し側の責務)。
   */
  triggerAsync(
    receiptId: string,
    onComplete?: (ev: CompleteEvent) => void,
  ): Promise<{ ok: boolean; pid: number | null; logFile: string; error?: string }> {
    return new Promise((resolveResult) => {
      const prompt = buildPrompt(receiptId, this.opts.backendBaseUrl);
      const logFile = this.logPath(receiptId);
      const startedAt = Date.now();
      let resolved = false;

      // ログ準備 (常に append、 過去ログは履歴として残す)
      mkdirSync(dirname(logFile), { recursive: true });
      const logStream = createWriteStream(logFile, { flags: "a" });
      const banner = `\n=== [${new Date().toISOString()}] claude code ocr start (receipt ${receiptId}) ===\n`;
      logStream.write(banner);
      logStream.write(`prompt length: ${prompt.length} chars\n`);
      logStream.write(`backend: ${this.opts.backendBaseUrl}\n`);
      logStream.write(`cwd: ${this.opts.workingDir ?? "(default)"}\n`);

      try {
        const env = { ...process.env };
        const bashPath = this.opts.bashPath ?? process.env.CLAUDE_CODE_GIT_BASH_PATH;
        if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;

        const model = safeModelName(this.opts.model);
        const args = ["-p", "--dangerously-skip-permissions"];
        if (model) args.push("--model", model);
        logStream.write(`model: ${model ?? "(claude cli default)"}\n`);

        const child = spawn("claude", args, {
          env,
          cwd: this.opts.workingDir,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
        });

        child.stdout?.on("data", (d) => logStream.write(d));
        child.stderr?.on("data", (d) => {
          logStream.write("[stderr] ");
          logStream.write(d);
        });

        child.once("error", (err) => {
          logStream.write(`\n[spawn error] ${err.message}\n`);
          logStream.end();
          if (!resolved) {
            resolved = true;
            resolveResult({ ok: false, pid: null, logFile, error: err.message });
          }
          onComplete?.({
            code: null, signal: null, logFile,
            tail: `spawn error: ${err.message}`,
            durationMs: Date.now() - startedAt,
          });
        });

        child.on("close", (code, signal) => {
          const banner2 = `\n=== [${new Date().toISOString()}] exit code=${code} signal=${signal ?? "-"} duration=${Date.now() - startedAt}ms ===\n`;
          logStream.write(banner2);
          logStream.end();
          // tail を読む (4KB)
          let tail = "";
          try {
            if (existsSync(logFile)) {
              const buf = readFileSync(logFile);
              tail = buf.subarray(Math.max(0, buf.length - 4096)).toString("utf8");
            }
          } catch { /* ignore */ }
          onComplete?.({
            code, signal, logFile, tail,
            durationMs: Date.now() - startedAt,
          });
        });

        // 入力を流す
        child.stdin.end(prompt);

        // safety: timeout で kill
        const t = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
        }, this.opts.timeoutMs ?? 180_000);
        t.unref();

        // 100ms 後に「spawn 成功」 とみなして即返却 (claude 自体は走らせ続ける)
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          resolveResult({ ok: true, pid: child.pid ?? null, logFile });
        }, 100);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logStream.write(`\n[exception] ${msg}\n`);
        logStream.end();
        if (!resolved) {
          resolved = true;
          resolveResult({ ok: false, pid: null, logFile, error: msg });
        }
        onComplete?.({
          code: null, signal: null, logFile,
          tail: `exception: ${msg}`,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  }
}

/** Prevent programmatic callers from turning the Windows shell invocation into command injection. */
function safeModelName(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? value
    : null;
}

/** テスト・後付け CLI から prompt 文面を検証できるよう公開する (spawn はしない)。 */
export function buildPrompt(receiptId: string, base: string): string {
  return `# Quaestor レシート画像 OCR タスク

あなたは Quaestor (個人会計サービス) のレシート OCR ヘルパーとして起動された。
以下の手順を **必ず最後まで** 実行する。 完了するまで他のタスクには手を出さない。

## レシート ID
${receiptId}

## 手順

1. **画像取得**: 一時ディレクトリに画像をダウンロード
   \`\`\`bash
   curl -s -o /tmp/receipt-${receiptId}.jpg ${base}/v1/receipts/${receiptId}/image
   \`\`\`

2. **画像解析**: Read tool で /tmp/receipt-${receiptId}.jpg を読む
   (画像は multimodal で視認できる)

3. **構造化抽出** — 以下のフィールドを判別:
   - \`date\`: ISO yyyy-mm-dd 形式 (年が見えない時は今年と推定)、 不明 → null
   - \`payee\`: 店名 / 発行元 (日本語そのまま)、 不明 → null
   - \`total\`: 合計金額 (整数、 円)、 不明 → null
   - \`items\`: [{name, price, qty?}] の配列。 自信が無い行は除外
   - \`confidence\`: "high" / "medium" / "low" — ぼやけ・切れ等で不確実なら低く

${classificationPromptSection()}

4. **PATCH 送信**: 結果を Quaestor backend に書き戻す
   \`\`\`bash
   curl -s -X PATCH ${base}/v1/receipts/${receiptId}/ocr \\
     -H 'content-type: application/json' \\
     --data-binary @- <<'JSON'
   {
     "ocr_status": "done",
     "date": "yyyy-mm-dd",
     "payee": "店名",
     "total": 1820,
     "items": [{"name":"商品A","price":460,"qty":1}],
     "kind": "receipt",
     "kind_fields": null,
     "sample": {"role": "good_sample", "tags": [], "reason": "全体が写り判読できる"},
     "content_tags": ["food"],
     "ocr_raw": "{...抽出 JSON 全部...}"
   }
   JSON
   \`\`\`
   - confidence="low" の場合は \`"ocr_status": "manual"\` (人間レビュー待ち)
   - PATCH 失敗 (HTTP error) なら \`"ocr_status": "failed"\` で再送
   - kind / kind_fields / sample / content_tags は **必ず同じ PATCH に含める** (2 回に分けない)

5. 終了。 1-2 文で結果サマリを出力 (例: "サイゼリヤ 中目黒店 ¥1820 / receipt / done で PATCH 済")

## 注意

- 画像が **書類以外** (背景・名刺・広告) なら status="manual"、 payee=null、 kind="other" で書き戻す
- 数字は半角、 カンマ・通貨記号除いて整数化
- false positive より miss を優先 — 自信無いフィールドは null
- 作業中に他のファイルを編集したり別タスクに脱線しないこと
`;
}

export function detectClaudeCli(): boolean {
  // 軽量プローブ: 環境変数 PATH に claude 実行ファイル候補があるかは判断難しいので、
  // CLAUDE_CODE_OCR_DISABLE=1 で off できる以外は「あるかもしれない」 と仮定して
  // spawn 時の error で実態判定する。
  return process.env.CLAUDE_CODE_OCR_DISABLE !== "1";
}

/** Quaestor プロジェクトルート (working dir) */
export function projectRoot(): string {
  return resolve(process.cwd());
}
