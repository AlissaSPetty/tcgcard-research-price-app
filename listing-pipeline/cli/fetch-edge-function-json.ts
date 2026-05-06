/** HTTP statuses where Supabase / CDN may return HTML or empty body — safe to retry. */
const TRANSIENT_HTTP = new Set([502, 503, 504]);

const MAX_ATTEMPTS = 6;

function shouldRetryEdgeJsonBody(res: Response, parsed: unknown): boolean {
  if (TRANSIENT_HTTP.has(res.status)) return true;
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  if (p.code === "WORKER_LIMIT") return true;
  const msg = String(p.message ?? "");
  if (/compute resources|not enough compute|WORKER_LIMIT/i.test(msg)) return true;
  return false;
}

/**
 * POST to an Edge Function and parse JSON. Retries on transient HTTP errors, non-JSON 502/503/504
 * bodies, and JSON failures such as Supabase `WORKER_LIMIT` (worker ran out of CPU/time).
 */
export async function fetchEdgeFunctionJson<T>(
  url: string,
  init: RequestInit,
  options: { name: string; hint504: string },
): Promise<{ res: Response; parsed: T; text: string }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init);
    const text = await res.text();

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      if (TRANSIENT_HTTP.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        const waitMs = Math.min(60_000, 2000 * 2 ** attempt);
        console.error(
          `${options.name}: HTTP ${res.status} (non-JSON response — often gateway timeout or overload). Retrying in ${waitMs / 1000}s…`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (text.length > 0) console.error(text.slice(0, 1200));
      throw new Error(
        res.status === 504
          ? `HTTP 504 Gateway Timeout. ${options.hint504}`
          : `Non-JSON response (HTTP ${res.status})`,
      );
    }

    const shouldRetry =
      attempt < MAX_ATTEMPTS - 1 && shouldRetryEdgeJsonBody(res, parsed);
    if (shouldRetry) {
      const waitMs = Math.min(60_000, 2500 * 2 ** attempt);
      const code = (parsed as Record<string, unknown>).code;
      console.error(
        `${options.name}: transient failure (HTTP ${res.status}${
          code != null ? `, code=${String(code)}` : ""
        }). Retrying in ${waitMs / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    return { res, parsed, text };
  }

  throw new Error(`${options.name}: too many transient HTTP failures`);
}
