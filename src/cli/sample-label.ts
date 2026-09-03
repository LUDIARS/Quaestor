/**
 * 既存レシートへの書類種別 / サンプルラベル後付け CLI (sample-labeler.ts のフロント)。
 *
 *   npm run sample:label                       # 未ラベルを全部 (直列、 中断再開可)
 *   npm run sample:label -- --limit 20         # 20 件だけ
 *   npm run sample:label -- --dry-run          # 対象を列挙するだけ (LLM を呼ばない)
 *   npm run sample:label -- --db tmp/copy.db   # 別 DB (既定は quaestor.config.json storage.dbPath)
 *
 * モデルは quaestor.config.json の ocrClaudeCode.model (OCR と同じ) に固定する。
 * 画像は claude が Read で視認する (`--allowedTools Read` のみ許可)。
 *
 * @implements SPEC-SCAN-KIND-004 (spec/feature/scan-document-kinds.md)
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyMigrations } from "../db/schema.js";
import { ReceiptsRepo } from "../db/receipts-repo.js";
import { ReceiptStorage } from "../services/receipt-storage.js";
import { loadAppConfig } from "../services/app-config.js";
import { runClaudeCliJson } from "../services/claude-cli.js";
import { runSampleLabeling } from "../services/sample-labeler.js";

interface CliArgs {
  limit?: number;
  dryRun: boolean;
  db?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit には正の整数を指定する");
      out.limit = n;
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit には正の整数を指定する");
      out.limit = n;
    } else if (a === "--db") {
      const p = argv[++i];
      if (!p) throw new Error("--db にはパスを指定する");
      out.db = p;
    } else if (a.startsWith("--db=")) {
      out.db = a.slice("--db=".length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function usage(): void {
  console.log("usage: npm run sample:label -- [--limit N] [--dry-run] [--db <path>]");
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    usage();
    return 1;
  }
  if (args.help) { usage(); return 0; }

  const config = loadAppConfig();
  const dbPath = resolve(args.db ?? config.storage.dbPath);
  if (!existsSync(dbPath)) {
    // 存在しない DB を黙って新規作成すると「0 件処理して成功」という無言故障になる
    console.error(`DB が見つからない: ${dbPath}`);
    return 1;
  }
  const receiptsRoot = resolve(config.storage.receiptsRoot);
  const model = config.ocrClaudeCode.model;

  const db = new Database(dbPath);
  try {
    applyMigrations(db);
    const receipts = new ReceiptsRepo(db);
    const storage = new ReceiptStorage(receiptsRoot);

    console.log(`db: ${dbPath}`);
    console.log(`receipts: ${receiptsRoot}`);
    console.log(`model: ${model ?? "(claude cli default)"}`);
    console.log(`unlabeled: ${receipts.countUnlabeled()}${args.limit ? ` (limit ${args.limit})` : ""}${args.dryRun ? " [dry-run]" : ""}`);

    const result = await runSampleLabeling(
      {
        receipts,
        storage,
        runner: (prompt) => runClaudeCliJson(prompt, {
          model,
          allowedTools: ["Read"],
          timeoutMs: 180_000,
          // prompt には個人データである画像の絶対パスが入るため、 cost telemetry には残さない。
          costPrompt: "[receipt classification prompt redacted]",
        }),
        logger: {
          info: (f) => console.log(`  ${JSON.stringify(f)}`),
          warn: (f) => console.warn(`  ${JSON.stringify(f)}`),
        },
      },
      { limit: args.limit, dryRun: args.dryRun },
    );

    if (args.dryRun) {
      for (const it of result.items) console.log(`  plan ${it.id}`);
    }
    console.log(
      `done: scanned ${result.scanned} / labeled ${result.labeled} / skipped ${result.skipped} / failed ${result.failed}`
      + ` (remaining ${receipts.countUnlabeled()})`,
    );
    return result.failed > 0 ? 2 : 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
