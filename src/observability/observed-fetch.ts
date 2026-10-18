import type { WorkerMetrics } from "./metrics.js";

export function observedFetch(
  metrics: WorkerMetrics,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    let status: number | undefined;
    try {
      const response = await fetchImplementation(input, init);
      status = response.status;
      return response;
    } finally {
      metrics.recordAppview(endpointName(input), performance.now() - started, status);
    }
  }) as typeof globalThis.fetch;
}

function endpointName(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw);
    const marker = "/xrpc/";
    const index = url.pathname.indexOf(marker);
    return index >= 0 ? url.pathname.slice(index + marker.length) : url.pathname;
  } catch {
    return "unknown";
  }
}
