/**
 * Claude Code CLI (`claude -p`) を spawn してレシート画像を解析する OCR backend。
 *
 * Anthropic SDK 経由 (AnthropicOcrClient) と並ぶ別経路。 こちらは:
 *  - 機械的 API key 不要 (claude CLI 自身の auth を使う)
 *  - 解析は claude のサイドで行われる (multimodal Read で画像を視認)
 *  - 結果は claude が直接 PATCH /v1/receipts/:id/ocr で書き戻す
 *  - サーバはプロセスを起動 → fire-and-forget。 OCR 状態は status='processing' に
 *    遷移、 完了は claude の PATCH で 'done'/'manual'/'failed' に切り替わる
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface ClaudeCodeOcrOptions {
  backendBaseUrl: string;
  /** Windows で git-bash パス (claude CLI 必須)。 環境変数 CLAUDE_CODE_GIT_BASH_PATH と同じ */
  bashPath?: string;
  /** 起動時の cwd。 既定はプロジェクトルート */
  workingDir?: string;
  /** 子プロセス kill タイムアウト (ms)。 既定 180_000 (3 分) */
  timeoutMs?: number;
}

export class ClaudeCodeOcr {
  constructor(private readonly opts: ClaudeCodeOcrOptions) {}

  /**
   * Fire-and-forget で claude を起動。 戻り値は spawn の成否のみ。
   * 解析結果の反映は claude が PATCH で書き込むことに依存する。
   */
  triggerAsync(receiptId: string): Promise<{ ok: boolean; pid: number | null; error?: string }> {
    return new Promise((resolve) => {
      const prompt = buildPrompt(receiptId, this.opts.backendBaseUrl);
      let resolved = false;
      try {
        const env = { ...process.env };
        const bashPath = this.opts.bashPath ?? process.env.CLAUDE_CODE_GIT_BASH_PATH;
        if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;

        const child = spawn("claude", ["-p", "--dangerously-skip-permissions"], {
          env,
          cwd: this.opts.workingDir,
          stdio: ["pipe", "ignore", "ignore"],
          shell: true,
          detached: true,
        });

        // process error は spawn 失敗で発火。 一度返却したら無視。
        child.once("error", (err) => {
          if (resolved) return;
          resolved = true;
          resolve({ ok: false, pid: null, error: err.message });
        });

        // 入力を流して unref (parent が終了しても子は走り続ける)
        child.stdin.end(prompt);
        child.unref();

        // safety: timeout で kill
        const t = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGTERM"); } catch {}
        }, this.opts.timeoutMs ?? 180_000);
        t.unref();

        // spawn が即座に成功した場合は process error が来ないので
        // 100ms 後に「成功」 とみなして返す
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          resolve({ ok: true, pid: child.pid ?? null });
        }, 100);
      } catch (e: unknown) {
        if (resolved) return;
        resolved = true;
        resolve({ ok: false, pid: null, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }
}

function buildPrompt(receiptId: string, base: string): string {
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
     "ocr_raw": "{...抽出 JSON 全部...}"
   }
   JSON
   \`\`\`
   - confidence="low" の場合は \`"ocr_status": "manual"\` (人間レビュー待ち)
   - PATCH 失敗 (HTTP error) なら \`"ocr_status": "failed"\` で再送

5. 終了。 1-2 文で結果サマリを出力 (例: "サイゼリヤ 中目黒店 ¥1820 / done で PATCH 済")

## 注意

- 画像が **レシート以外** (背景・名刺・広告) なら status="manual"、 payee=null で書き戻す
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
