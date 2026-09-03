/**
 * OCR-GA ラベル別ベンチマーク CLI (services/ocr-ga-bench のフロント)。
 *
 *   npm run ga:bench -- --label global --generations 1 --limit 20 --population 4 --out tmp/ga-bench
 *
 * options:
 *   --label <key>           走らせるラベル (global / tag:<x>)。複数指定可。省略 = コーパスの全ラベル
 *   --generations <n>       進める世代数 (既定 1)
 *   --limit <n>             ラベルごとのコーパス上限 (新しい順)
 *   --population <n>        1 世代で評価する個体数の上限
 *   --out <dir>             GA 集団 / evolution.jsonl / bench-report.json の出力先。
 *                           省略すると quaestor.config.json の training.gaRoot (= 本番) に書く
 *   --sidecar <url>         sidecar URL (既定: training.gaBench.sidecarUrl → ocrSidecar)
 *   --device cpu|gpu        sidecar に期待する device (既定: training.gaBench.device)
 *   --cost-per-second <x>   fitness のコスト項係数 (既定: training.gaBench.costPerSecond)
 *   --db <path>             DB (既定: storage.dbPath)。常に read-only で開く
 *   --receipts-root <dir>   レシート画像ルート (既定: storage.receiptsRoot)
 *
 * 本番 DB と画像は読むだけ。進捗は stderr、最終 report は stdout (JSON 1 つ)。
 * sidecar 不達 / device 不一致 / ラベル不在は exit 1。
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { gaBenchSidecarUrlOf, loadAppConfig } from "../services/app-config.js";
import { runGaBench } from "../services/ocr-ga-bench/bench-runner.js";
import { HttpOcrSidecarClient } from "../services/ocr-sidecar-client.js";
import { ReceiptStorage } from "../services/receipt-storage.js";

interface CliArgs {
  labels: string[];
  generations: number;
  limit?: number;
  population?: number;
  out?: string;
  sidecar?: string;
  device?: "cpu" | "gpu";
  costPerSecond?: number;
  db?: string;
  receiptsRoot?: string;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { labels: [], generations: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--label": args.labels.push(next()); break;
      case "--generations": args.generations = positiveInt(a, next()); break;
      case "--limit": args.limit = positiveInt(a, next()); break;
      case "--population": args.population = positiveInt(a, next()); break;
      case "--out": args.out = next(); break;
      case "--sidecar": args.sidecar = next(); break;
      case "--device": {
        const v = next();
        if (v !== "cpu" && v !== "gpu") throw new Error(`--device must be cpu or gpu (got ${v})`);
        args.device = v;
        break;
      }
      case "--cost-per-second": {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new Error("--cost-per-second must be a non-negative number");
        args.costPerSecond = v;
        break;
      }
      case "--db": args.db = next(); break;
      case "--receipts-root": args.receiptsRoot = next(); break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return args;
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got ${raw})`);
  return n;
}

function usage(): string {
  return [
    "usage: npm run ga:bench -- [--label <key>]... [--generations N] [--limit N] [--population N]",
    "                           [--out DIR] [--sidecar URL] [--device cpu|gpu] [--cost-per-second X]",
    "                           [--db PATH] [--receipts-root DIR]",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e: unknown) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${usage()}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const config = loadAppConfig();
  const bench = config.training.gaBench;
  const dbPath = args.db ?? config.storage.dbPath;
  if (!existsSync(dbPath)) {
    process.stderr.write(`db not found: ${dbPath}\n`);
    return 1;
  }
  const gaRoot = args.out ?? config.training.gaRoot;
  const sidecarUrl = args.sidecar ?? gaBenchSidecarUrlOf(config);

  // 本番 DB は読むだけ。書き込み経路を持たない
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    process.stderr.write(`ga:bench db=${dbPath} gaRoot=${gaRoot} sidecar=${sidecarUrl} labels=${args.labels.join(",") || "(all)"}\n`);
    const report = await runGaBench({
      db,
      storage: new ReceiptStorage(args.receiptsRoot ?? config.storage.receiptsRoot),
      gaRoot,
      sidecar: new HttpOcrSidecarClient({ baseUrl: sidecarUrl }),
      labels: args.labels,
      generations: args.generations,
      limit: args.limit,
      population: args.population,
      costPerSecond: args.costPerSecond ?? bench.costPerSecond,
      expectedDevice: args.device ?? bench.device,
      logger: {
        info: (obj, msg) => process.stderr.write(`[info] ${msg ?? ""} ${JSON.stringify(obj)}\n`),
        warn: (obj, msg) => process.stderr.write(`[warn] ${msg ?? ""} ${JSON.stringify(obj)}\n`),
      },
      onProgress: (p) => process.stderr.write(`[${p.label}] gen ${p.generation} ${p.attempt}/${p.total} fitness=${p.fitness}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (e: unknown) {
    process.stderr.write(`ga:bench failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    db.close();
  }
}

// tsx から直接実行されたときだけ動く (テストは parseArgs を import する)
if (process.argv[1] && /ga-bench\.(?:ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
