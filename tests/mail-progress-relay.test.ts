import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayMailProgress } from "../src/services/mail-progress-relay.js";
import { acceptedProgressMessageId } from "../src/services/mail-progress-receipt.js";

const accepted = (id: unknown = 42): unknown => ({ ok: true, relayed: 1, message: { message: { id } } });
const previous = { sentAt: 1, status: "active", error: null };
const next = { sentAt: 2, status: "exhausted", error: null };
let dir: string;
const transport = vi.fn<typeof fetch>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mail-progress-relay-"));
  vi.stubGlobal("fetch", transport);
  transport.mockReset();
  await writeFile(join(dir, "checkpoint.json"), JSON.stringify(previous));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function read(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, name), "utf8"));
}
async function expectPending(): Promise<void> {
  expect(await read("delivery-pending.json")).toEqual({ attemptedAt: expect.any(Number) });
  expect(await read("checkpoint.json")).toEqual(previous);
  await expect(read("receipt.json")).rejects.toMatchObject({ code: "ENOENT" });
  const pending = await readFile(join(dir, "delivery-pending.json"), "utf8");
  await expect(relayMailProgress("http://fixture.invalid", dir, "retry", next)).rejects.toMatchObject({ code: "EEXIST" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await readFile(join(dir, "delivery-pending.json"), "utf8")).toBe(pending);
  expect(await readFile(join(dir, "progress.txt"), "utf8")).toBe("progress\n");
}

describe("mail progress relay acceptance", () => {
  it("stores the nested Cc ID as API acceptance, without session or Discord evidence", async () => {
    transport.mockResolvedValue(Response.json({ ok: true, relayed: 1, message: {
      id: 99, message: { id: 42, session_id: "fixture-session", text: "fixture-private" },
    } }));
    await relayMailProgress("http://fixture.invalid", dir, "progress", next);
    expect(await read("receipt.json")).toEqual({ acceptedAt: expect.any(Number), messageId: 42 });
    expect(await read("checkpoint.json")).toEqual(next);
    await expect(read("delivery-pending.json")).rejects.toMatchObject({ code: "ENOENT" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, 0, -1, 1.5, "42", "", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
    "keeps pending for an invalid or missing ID (%j)", async (id) => {
      transport.mockResolvedValue(Response.json(accepted(id)));
      // undefined is intentionally missing rather than the fixture default.
      if (id === undefined) transport.mockResolvedValue(Response.json({ ok: true, relayed: 1, message: { message: {} } }));
      await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
      await expectPending();
    },
  );
  it.each([null, {}, { ok: true, relayed: 1, message: { id: 42 } },
    { ok: true, skipped: "no concordia" }, { ok: false, relayed: 1, message: { message: { id: 42 } } },
    { ok: "true", relayed: 1, message: { message: { id: 42 } } },
    { ok: true, relayed: 2, message: { message: { id: 42 } } }])(
    "rejects malformed or unsuccessful envelopes (%j)", async (body) => {
      transport.mockResolvedValue(Response.json(body));
      await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
      await expectPending();
    },
  );
  it.each([400, 502])("keeps pending on HTTP %i even with a valid-looking body", async (status) => {
    transport.mockResolvedValue(Response.json(accepted(), { status }));
    await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
    await expectPending();
  });
  it("keeps pending after an unreadable response", async () => {
    transport.mockResolvedValue(new Response("not-json"));
    await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
    await expectPending();
  });
  it("keeps pending after an ambiguous transport failure", async () => {
    transport.mockRejectedValue(new Error("fixture timeout"));
    await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
    await expectPending();
  });
  it("preserves previous acceptance evidence on failure", async () => {
    const receipt = { acceptedAt: 1, messageId: 7 };
    await writeFile(join(dir, "receipt.json"), JSON.stringify(receipt));
    transport.mockResolvedValue(Response.json({ ok: true }));
    await expect(relayMailProgress("http://fixture.invalid", dir, "progress", next)).rejects.toThrow();
    expect(await read("receipt.json")).toEqual(receipt);
    expect(await read("checkpoint.json")).toEqual(previous);
  });
  it("validates number boundaries without coercing or rounding IDs", () => {
    for (const id of [1, Number.MAX_SAFE_INTEGER]) expect(acceptedProgressMessageId(accepted(id))).toBe(id);
    for (const id of [NaN, Infinity, -Infinity]) expect(acceptedProgressMessageId(accepted(id))).toBeNull();
  });
});
