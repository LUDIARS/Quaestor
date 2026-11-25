/** Owns one recovery job and its shutdown signal. Normal mail uses the shared Gmail pacer and DB claims. */
export class MailRecoveryGate {
  private lease?: { controller: AbortController; finished: Promise<void> };
  private stopping = false;

  acquire(): { signal: AbortSignal; release: () => void } {
    if (this.stopping || this.lease) throw new Error("recovery_busy");
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const lease = this.lease = { controller, finished };
    return { signal: controller.signal, release: () => {
      if (this.lease === lease) this.lease = undefined;
      finish();
    } };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lease?.controller.abort();
    await this.lease?.finished;
  }
}
