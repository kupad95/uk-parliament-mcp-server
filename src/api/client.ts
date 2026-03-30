// Base HTTP client for parliament.uk APIs

// ─── In-memory cache ─────────────────────────────────────────────────────────

const _cache = new Map<string, { value: unknown; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const BILLS_API = "https://bills-api.parliament.uk/api/v1";
export const COMMONS_VOTES_API = "https://commonsvotes-api.parliament.uk/data";
export const LORDS_VOTES_API = "https://lordsvotes-api.parliament.uk/data";
export const MEMBERS_API = "https://members-api.parliament.uk/api";
export const PETITIONS_API = "https://petition.parliament.uk";

/**
 * Pauses execution for `ms` milliseconds — use between chained API requests
 * to stay polite with Parliament's undocumented rate limits.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a query string from a params object, omitting any keys whose value
 * is `undefined` or `null`.
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  if (entries.length === 0) return "";
  const qs = entries
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
    )
    .join("&");
  return `?${qs}`;
}

/**
 * Fetch a Parliament API endpoint.
 *
 * @param url    Full URL (no query string) or URL already containing a query string.
 * @param params Optional query parameters to append. Keys with undefined / null
 *               values are silently dropped.
 */
export async function parliamentFetch(
  url: string,
  params?: Record<string, string | number | boolean | undefined | null>
): Promise<unknown> {
  const fullUrl = params ? `${url}${buildQueryString(params)}` : url;

  const cached = _cache.get(fullUrl);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  const response = await fetch(fullUrl, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore body read errors
    }
    throw new Error(
      `Parliament API request failed: ${response.status} ${response.statusText} — ${fullUrl}${body ? ` — ${body.slice(0, 200)}` : ""}`
    );
  }

  const value = await response.json();
  _cache.set(fullUrl, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

// ─── Batched parallel fetch ───────────────────────────────────────────────────

/**
 * Fetch a list of items in parallel with a concurrency limit.
 * Sends `concurrency` requests at a time, waits `batchDelayMs` between batches.
 * Uses Promise.allSettled so individual failures don't abort the batch.
 */
export async function batchedFetch<T, R>(
  items: T[],
  fetcher: (item: T) => Promise<R>,
  concurrency = 5,
  batchDelayMs = 50
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fetcher));
    for (const s of settled) {
      results.push(s.status === "fulfilled" ? s.value : null);
    }
    if (i + concurrency < items.length) {
      await delay(batchDelayMs);
    }
  }

  return results;
}
