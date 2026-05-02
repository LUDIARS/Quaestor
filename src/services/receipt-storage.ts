/**
 * レシート画像の永続化。 個人データなので app_data/ 配下に置き、 git に出さない。
 *
 * パス: <root>/yyyy/mm/<id>.<ext>
 *
 * テストでは tmp dir を root に渡せるよう DI 構成にしてある。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface SaveResult {
  /** root からの相対 path (DB に保存する) */
  relativePath: string;
  /** OS の絶対 path */
  absolutePath: string;
  size: number;
}

export class ReceiptStorage {
  constructor(private readonly root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * 画像 buffer を保存。 yyyy/mm 階層を切る。 ext 既定 'jpg'。
   * 戻り値の relativePath を Receipt.image_path に保存する。
   */
  save(id: string, buf: Buffer, capturedAt: Date | number = new Date(), ext = "jpg"): SaveResult {
    const date = capturedAt instanceof Date
      ? capturedAt
      : new Date(capturedAt * 1000);
    const yyyy = date.getUTCFullYear().toString();
    const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
    const dir = join(this.root, yyyy, mm);
    mkdirSync(dir, { recursive: true });
    const filename = `${id}.${ext}`;
    const abs = resolve(dir, filename);
    writeFileSync(abs, buf);
    const rel = join(yyyy, mm, filename).replaceAll("\\", "/");
    return { relativePath: rel, absolutePath: abs, size: buf.length };
  }

  /** relativePath から Buffer を読む。 ファイル無しなら null */
  load(relativePath: string): Buffer | null {
    const abs = resolve(this.root, relativePath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs);
  }

  resolve(relativePath: string): string {
    return resolve(this.root, relativePath);
  }
}
