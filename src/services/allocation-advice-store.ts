/**
 * 資産配分アドバイスの最新 1 件をファイルにキャッシュする (LLM 再実行を避ける)。
 * DB を汚さないよう JSON ファイル 1 枚 (notification-state と同流儀)。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PortfolioSnapshot, AllocationAdvice, AdviceProfile } from "./allocation-advisor.js";

export interface StoredAllocationAdvice {
  snapshot: PortfolioSnapshot;
  advice: AllocationAdvice;
  profile: AdviceProfile;
  generated_at: number;
}

export class AllocationAdviceStore {
  constructor(private readonly path: string) {}

  get(): StoredAllocationAdvice | null {
    if (!existsSync(this.path)) return null;
    try { return JSON.parse(readFileSync(this.path, "utf8")) as StoredAllocationAdvice; } catch { return null; }
  }

  save(entry: StoredAllocationAdvice): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entry, null, 2), "utf8");
  }
}
