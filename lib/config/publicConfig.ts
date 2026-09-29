import type { PublicConfig } from './redact.ts';

export type { PublicConfig } from './redact.ts';

let cached: Promise<PublicConfig> | null = null;

export async function fetchPublicConfig(): Promise<PublicConfig> {
  if (cached) return cached;

  const pending = (async () => {
    let response: Response;
    try {
      response = await fetch('/api/public-config');
    } catch (err) {
      throw new Error(`Failed to fetch public config: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new Error(`Public config endpoint returned ${response.status}`);
    }
    try {
      return (await response.json()) as PublicConfig;
    } catch (err) {
      // An SPA fallback or a half-deployed proxy can answer 200 with HTML.
      throw new Error(`Public config body was not JSON: ${(err as Error).message}`);
    }
  })();

  cached = pending;

  // Clear the cache on ANY failure, so a later attempt can succeed. Doing this
  // in one place matters: the previous version reset the cache only in the
  // fetch-throws and non-OK branches, so a body that failed to parse left the
  // rejected promise cached forever and every retry returned that same
  // rejection. The identity check keeps a slow failure from clearing a newer
  // in-flight attempt. Attaching the handler here also stops the rejection
  // being reported as unhandled when the first caller has not awaited yet.
  pending.catch(() => {
    if (cached === pending) cached = null;
  });

  return pending;
}

export function resetPublicConfigCache(): void {
  cached = null;
}
