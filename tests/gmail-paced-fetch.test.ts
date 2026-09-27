import { describe, expect, it, vi } from "vitest";
import { gmailPacedFetch } from "../src/services/gmail-paced-fetch.js";

describe("Gmail request pacing", () => {
  it("serializes parallel callers and waits before each request", async () => {
    const events: string[] = [];
    const upstream = vi.fn(async () => { events.push("fetch"); return new Response("{}"); });
    const pause = vi.fn(async (ms: number) => { events.push(`pause:${ms}`); });
    const fetcher = gmailPacedFetch(upstream as typeof fetch, pause);
    await Promise.all([fetcher("https://example.test/1"), fetcher("https://example.test/2")]);
    expect(events).toEqual(["pause:200", "fetch", "pause:200", "fetch"]);
  });

  it("passes errors to callers without poisoning subsequent requests", async () => {
    const upstream = vi.fn().mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response("{}"));
    const fetcher = gmailPacedFetch(upstream as typeof fetch, async () => {});
    const results = await Promise.allSettled([fetcher("https://example.test/1"), fetcher("https://example.test/2")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });
});
