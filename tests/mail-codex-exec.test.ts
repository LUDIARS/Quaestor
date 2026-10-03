import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnOneShot as spawn } from "@ludiars/one-shot";
import { mailCodexArgs, mailCodexEnv, runMailCodex } from "../src/services/mail-codex-exec.js";

vi.mock("@ludiars/one-shot", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ludiars/one-shot")>(), spawnOneShot: vi.fn(),
}));

function childFixture(output: string, exitCode = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }),
  });
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  child.stdin.on("finish", () => {
    child.stdout.write(output);
    child.emit("close", exitCode);
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return { child, input: () => input };
}

const success = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"kind":"review","confidence":0.4}' } })
  + '\n{"type":"turn.completed"}\n';

describe("mail Codex subprocess boundary", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  it("passes mail only through stdin and requires a completed successful turn", async () => {
    vi.stubEnv("QUAESTOR_CODEX_PATH", process.execPath);
    const child = childFixture(success);
    await expect(runMailCodex("private mail", {})).resolves.toEqual({ kind: "review", confidence: 0.4 });
    expect(child.input()).toBe("private mail");
    const call = vi.mocked(spawn).mock.calls[0]!;
    expect(JSON.stringify(call)).not.toContain("private mail");
    expect(call[2]).toMatchObject({ shell: false, windowsHide: true });
    expect(call[1]).toContain("--ephemeral");
  });
  it("rejects a failed process even if it emitted valid classification JSON", async () => {
    vi.stubEnv("QUAESTOR_CODEX_PATH", process.execPath);
    childFixture(success, 1);
    await expect(runMailCodex("mail", {})).rejects.toMatchObject({ code: "mail_luna_cli_failed" });
  });
  it("rejects missing completion and unexpected tool activity", async () => {
    vi.stubEnv("QUAESTOR_CODEX_PATH", process.execPath);
    childFixture(success.split('\n')[0]! + '\n');
    await expect(runMailCodex("mail", {})).rejects.toMatchObject({ code: "mail_luna_cli_failed" });
    const fixture = childFixture('{"type":"item.started","item":{"type":"command_execution"}}\n' + success);
    await expect(runMailCodex("mail", {})).rejects.toMatchObject({ code: "mail_luna_unexpected_tool" });
    expect(fixture.child.kill).toHaveBeenCalled();
  });
  it("resolves the shared model override without changing classification restrictions", () => {
    vi.stubEnv("LUDIARS_ONESHOT_MODEL_LUNA", "gpt-test-luna");
    const args = mailCodexArgs("schema.json");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-test-luna");
    expect(args).toContain("read-only");
  });
  it("excludes service secrets and disables execution capabilities", () => {
    expect(mailCodexEnv({ PATH: "bin", USERPROFILE: "profile", OPENAI_API_KEY: "secret", GMAIL_TOKEN: "secret", LICTOR_PORT: "1" }))
      .toEqual({ PATH: "bin", USERPROFILE: "profile" });
    const args = mailCodexArgs("schema.json");
    expect(args).toContain("read-only"); expect(args).toContain("--ignore-user-config");
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent"]) {
      expect(args[args.indexOf(feature) - 1]).toBe("--disable");
    }
  });
});
