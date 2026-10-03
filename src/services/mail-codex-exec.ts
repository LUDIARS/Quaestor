import { spawnOneShot as spawn, resolveModel } from "@ludiars/one-shot";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const failure = (code: string): Error => Object.assign(new Error("Mail analysis unavailable"), { code });
const DISABLED = ["shell_tool", "unified_exec", "code_mode", "code_mode_host", "apps", "plugins", "hooks",
  "multi_agent", "multi_agent_v2", "tool_suggest", "browser_use", "browser_use_external", "in_app_browser",
  "computer_use", "image_generation", "view_image"];

export function resolveMailCodex(): string | null {
  const override = process.env.QUAESTOR_CODEX_PATH;
  if (override) return isAbsolute(override) && existsSync(override)
    && (process.platform !== "win32" || override.endsWith(".exe")) ? override : null;
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin", name));
  return candidates.find((path) => isAbsolute(path) && existsSync(path)) ?? null;
}

export function mailCodexArgs(schema: string): string[] {
  return ["-a", "never", "exec", "--model", resolveModel("luna", "codex"), "--sandbox", "read-only", "--ephemeral",
    "--ignore-user-config", "--skip-git-repo-check", "--json", "--color", "never", "--output-schema", schema,
    "-c", 'model_reasoning_effort="none"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
    ...DISABLED.flatMap((name) => ["--disable", name]), "-"];
}

export function mailCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}

/** Runs a bounded, tool-free classification through the existing Codex login. */
export async function runMailCodex(prompt: string, schema: object): Promise<unknown> {
  const executable = resolveMailCodex();
  if (!executable) throw failure("mail_luna_cli_missing");
  if (Buffer.byteLength(prompt, "utf8") > 160_000) throw failure("mail_luna_input_limit");
  const dir = await mkdtemp(join(tmpdir(), "quaestor-mail-luna-"));
  const schemaPath = join(dir, "schema.json");
  try {
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return await collect(executable, dir, schemaPath, prompt);
  } finally {
    await unlink(schemaPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw failure("mail_luna_cleanup_failed");
    });
    await rmdir(dir).catch(() => { throw failure("mail_luna_cleanup_failed"); });
  }
}

function collect(executable: string, cwd: string, schema: string, prompt: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, mailCodexArgs(schema), {
      cwd, env: mailCodexEnv(process.env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "", answer = "", errorCode = "", bytes = 0, completed = false;
    const fail = (code: string): void => { errorCode ||= code; child.kill("SIGKILL"); };
    const consume = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "turn.failed" || event.type === "error") fail("mail_luna_cli_failed");
        if (event.type === "turn.completed") completed = true;
        if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(event.item?.type)) fail("mail_luna_unexpected_tool");
        if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text;
      } catch { fail("mail_luna_invalid_result"); }
    };
    const timer = setTimeout(() => fail("mail_luna_timeout"), 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 2_000_000) { fail("mail_luna_output_limit"); return; }
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; lines.forEach(consume);
    });
    // Drain diagnostics without retaining or logging potentially sensitive model output.
    child.stderr.resume();
    child.stdin.on("error", () => fail("mail_luna_cli_input_failed"));
    child.on("error", () => { errorCode ||= "mail_luna_cli_start_failed"; });
    child.on("close", (code) => {
      clearTimeout(timer); consume(buffer);
      if (errorCode || code !== 0 || !completed || !answer) { reject(failure(errorCode || "mail_luna_cli_failed")); return; }
      try { resolve(JSON.parse(answer)); } catch { reject(failure("mail_luna_invalid_result")); }
    });
    child.stdin.end(prompt, "utf8");
  });
}
