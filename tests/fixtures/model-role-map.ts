import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export function stubModelRoleMap(roles: Record<string, Record<string, string>>): () => void {
  const directory = mkdtempSync(join(tmpdir(), "quaestor-model-roles-"));
  const path = join(directory, "model-roles.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, roles }), "utf8");
  vi.stubEnv("LUDIARS_MODEL_ROLES_FILE", path);
  vi.stubEnv("LUDIARS_ONESHOT_MODEL_HAIKU", undefined);
  vi.stubEnv("LUDIARS_ONESHOT_MODEL_LUNA", undefined);
  return () => rmSync(directory, { recursive: true, force: true });
}
