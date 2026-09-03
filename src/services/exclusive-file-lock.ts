/**
 * 同じ永続ファイルを複数プロセスから更新しないための軽量 lock-file。
 * owner process が残っていない lock は回収し、正常経路では返した release で必ず解放する。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class ExclusiveFileLockError extends Error {
  constructor(readonly lockPath: string) {
    super("resource is locked by another process");
    this.name = "ExclusiveFileLockError";
  }
}

export function acquireExclusiveFileLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { encoding: "utf8", flag: "wx" });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(lockPath); } catch { /* owner 終了時の best-effort cleanup */ }
      };
    } catch (error: unknown) {
      if (!isAlreadyExists(error) || attempt > 0 || !removeOrphanedLock(lockPath)) {
        throw isAlreadyExists(error) ? new ExclusiveFileLockError(lockPath) : error;
      }
    }
  }
  throw new ExclusiveFileLockError(lockPath);
}

function removeOrphanedLock(lockPath: string): boolean {
  const pid = readOwnerPid(lockPath);
  if (pid == null || isProcessAlive(pid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readOwnerPid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
