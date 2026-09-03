/**
 * レシート画像の永続化。 個人データなので app_data/ 配下に置き、 git に出さない。
 *
 * パス: <root>/yyyy/mm/<id>.<ext>
 *
 * テストでは tmp dir を root に渡せるよう DI 構成にしてある。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, join, sep } from "node:path";

export interface SaveResult {
  /** root からの相対 path (DB に保存する) */
  relativePath: string;
  /** OS の絶対 path */
  absolutePath: string;
  size: number;
}

export class ReceiptStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
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
    let abs: string;
    try {
      abs = this.resolve(relativePath);
    } catch {
      return null;
    }
    if (!existsSync(abs)) return null;
    return readFileSync(abs);
  }

  resolve(relativePath: string): string {
    const absolutePath = resolve(this.root, relativePath);
    const pathFromRoot = relative(this.root, absolutePath);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error("receipt image path escapes storage root");
    }
    return absolutePath;
  }
}
