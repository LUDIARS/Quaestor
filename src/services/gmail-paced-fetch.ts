import { setTimeout as delay } from "node:timers/promises";
import { checkGmailLimit, GmailRateLimit } from "./gmail-rate-limit.js";

/** @implements SPEC-MAIL-FETCH-PACING-001 */
export function gmailPacedFetch(
  upstream: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = async (ms) => { await delay(ms); },
  now: () => number = Date.now,
): typeof fetch {
  let tail: Promise<void> = Promise.resolve();
  let usage: { at: number; cost: number }[] = [];
  let cooldown = 0;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = tail.then(async () => {
      // Serialize the shared source's list/get/attachment requests, including concurrent sweeps.
      await pause(200);
      const at = now();
      if (at < cooldown) throw new GmailRateLimit(cooldown, 0, "cooldown");
      usage = usage.filter((entry) => at - entry.at < 60_000);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const cost = /\/messages$/.test(url.pathname) ? 5 : /\/history$/.test(url.pathname) ? 2
        : /\/profile$/.test(url.pathname) ? 1 : /\/watch$/.test(url.pathname) ? 100 : 20;
      // Reserve 10% of the published 6000 units/minute user budget for other operations.
      if (usage.reduce((sum, entry) => sum + entry.cost, 0) + cost > 5400) {
        throw new GmailRateLimit((usage[0]?.at ?? at) + 60_001, 0, "localBudget");
      }
      usage.push({ at, cost });
      const result = await upstream(input, init);
      try { await checkGmailLimit(result, now()); }
      catch (error) { if (error instanceof GmailRateLimit) cooldown = error.retryAt; throw error; }
      return result;
    });
    // A failed request must not poison the remaining queue. Errors still reach its caller.
    tail = response.then(() => undefined, () => undefined);
    return response;
  }) as typeof fetch;
}
