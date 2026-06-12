/**
 * 暗号化シークレットストア (AIFormat RULE.md §7.2)。
 *
 * API キー等のシークレットを **平文でファイル保存しない**。
 *  - 保存形式: AES-256-GCM (AEAD) で暗号化した JSON → `app_data/secrets.enc.json`
 *  - 鍵: 本体と分離して `~/.quaestor/secret.key` (32byte ランダム、初回生成)
 *  - 復号結果はプロセスメモリのみ。`injectSecrets()` が起動時に
 *    process.env へ注入する (= §7.2 の「起動時の env 注入」をストアから行う)。
 *
 * 登録 CLI: `npm run secret -- set ANTHROPIC_API_KEY <value>` (src/cli/secret.ts)
 */

import {
  createCipheriv, createDecipheriv, randomBytes,
} from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const ALG = "aes-256-gcm";

export interface SecretStoreOptions {
  /** 暗号化データの保存先。既定 app_data/secrets.enc.json */
  file?: string;
  /** 鍵ファイル。既定 ~/.quaestor/secret.key (データ本体と分離) */
  keyFile?: string;
}

interface EncFile {
  v: 1;
  alg: typeof ALG;
  iv: string;   // base64
  tag: string;  // base64
  data: string; // base64 (暗号文)
}

export class SecretStore {
  private readonly file: string;
  private readonly keyFile: string;

  constructor(opts: SecretStoreOptions = {}) {
    this.file = resolve(opts.file ?? "app_data/secrets.enc.json");
    this.keyFile = resolve(opts.keyFile ?? join(homedir(), ".quaestor", "secret.key"));
  }

  /** 全シークレットを復号して返す (ストア未作成は {}) */
  load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const enc = JSON.parse(readFileSync(this.file, "utf8")) as EncFile;
      const key = this.readKey();
      if (!key) return {};
      const d = createDecipheriv(ALG, key, Buffer.from(enc.iv, "base64"));
      d.setAuthTag(Buffer.from(enc.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(enc.data, "base64")), d.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch {
      return {}; // 壊れた/鍵不一致は「無し」として動く (起動は止めない)
    }
  }

  /** 1 件登録 (既存は上書き)。鍵は初回に自動生成 */
  set(name: string, value: string): void {
    const all = this.load();
    all[name] = value;
    this.save(all);
  }

  /** 1 件削除。 @returns 存在したか */
  remove(name: string): boolean {
    const all = this.load();
    if (!(name in all)) return false;
    delete all[name];
    this.save(all);
    return true;
  }

  /** 登録済みの参照名のみ (値は返さない) */
  names(): string[] {
    return Object.keys(this.load()).sort();
  }

  /**
   * 復号した値を process.env に注入する (未設定のキーのみ)。
   * プロセスメモリ内に閉じ、ディスクへは書かない。
   * @returns 注入した参照名
   */
  injectIntoEnv(): string[] {
    const injected: string[] = [];
    for (const [k, v] of Object.entries(this.load())) {
      if (process.env[k] === undefined || process.env[k] === "") {
        process.env[k] = v;
        injected.push(k);
      }
    }
    return injected.sort();
  }

  private save(all: Record<string, string>): void {
    const key = this.ensureKey();
    const iv = randomBytes(12);
    const c = createCipheriv(ALG, key, iv);
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(all), "utf8")), c.final()]);
    const enc: EncFile = {
      v: 1, alg: ALG,
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(enc, null, 2), "utf8");
  }

  private readKey(): Buffer | null {
    if (!existsSync(this.keyFile)) return null;
    const b = readFileSync(this.keyFile);
    return b.length === 32 ? b : null;
  }

  private ensureKey(): Buffer {
    const existing = this.readKey();
    if (existing) return existing;
    const key = randomBytes(32);
    mkdirSync(dirname(this.keyFile), { recursive: true });
    writeFileSync(this.keyFile, key);
    try { chmodSync(this.keyFile, 0o600); } catch { /* Windows ACL は別管理 */ }
    return key;
  }
}
