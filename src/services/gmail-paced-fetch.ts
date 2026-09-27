import { setTimeout as delay } from "node:timers/promises";

/** @implements SPEC-MAIL-FETCH-PACING-001 */
export function gmailPacedFetch(
  upstream: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = async (ms) => { await delay(ms); },
): typeof fetch {
  let tail: Promise<void> = Promise.resolve();
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = tail.then(async () => {
      // Serialize the shared source's list/get/attachment requests, including concurrent sweeps.
      await pause(200);
      return upstream(input, init);
    });
    // A failed request must not poison the remaining queue. Errors still reach its caller.
    tail = response.then(() => undefined, () => undefined);
    return response;
  }) as typeof fetch;
}
