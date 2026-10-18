import { currentDatetimeString } from "@atproto/lex";
import type { AnalyticsStore } from "../storage/store.js";

export class ApiSyncClient {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
    private readonly workerId: string,
    private readonly store: AnalyticsStore,
    private readonly batchSize: number,
  ) {}

  async flush(signal?: AbortSignal): Promise<number> {
    if (!this.endpoint) return 0;
    const events = await this.store.outbox(this.batchSize);
    if (events.length === 0) return 0;
    const batchId = `${this.workerId}:${events[0]!.id}-${events.at(-1)!.id}`;
    const headers = new Headers({ "content-type": "application/json" });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({ batchId, workerId: this.workerId, sentAt: currentDatetimeString(), events }),
    };
    if (signal) init.signal = signal;
    const response = await fetch(this.endpoint, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Worker sync failed with HTTP ${response.status}`);
    }
    await this.store.markOutboxDelivered(events.map((event) => event.id));
    return events.length;
  }
}
