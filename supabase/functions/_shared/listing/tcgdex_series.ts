/**
 * TCGdex series list → `pokemon_series_display` enrichment.
 * @see https://tcgdex.dev/ — REST e.g. GET /v2/en/series
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type TcgdexSerieBrief = { id: string; name: string };

function jsonHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "User-Agent": "tcgcard-research-price-app/1.0",
  };
}

/** Base URL without trailing slash, e.g. https://api.tcgdex.net/v2 */
export function tcgdexV2Base(): string {
  const raw = Deno.env.get("TCGDEX_API_BASE")?.trim() ||
    "https://api.tcgdex.net/v2";
  return raw.replace(/\/$/, "");
}

export async function fetchTcgdexSeriesBriefs(
  language = "en",
): Promise<TcgdexSerieBrief[]> {
  const url = `${tcgdexV2Base()}/${language}/series`;
  const res = await fetch(url, { headers: jsonHeaders() });
  if (!res.ok) {
    throw new Error(`tcgdex series HTTP ${res.status} for ${url}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("tcgdex series: expected JSON array");
  }
  const out: TcgdexSerieBrief[] = [];
  for (const raw of data) {
    const o = raw as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    const name = String(o.name ?? "").trim();
    if (id && name) out.push({ id, name });
  }
  return out;
}

/** Case-insensitive id → official series name */
export function tcgdexSeriesNameByIdLower(
  briefs: TcgdexSerieBrief[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of briefs) m.set(b.id.toLowerCase(), b.name);
  return m;
}

/** Official id casing from briefs (for storage) */
export function tcgdexCanonicalIdForPrefix(
  briefs: TcgdexSerieBrief[],
  prefix: string,
): string | null {
  const key = prefix.trim().toLowerCase();
  if (!key) return null;
  for (const b of briefs) {
    if (b.id.toLowerCase() === key) return b.id;
  }
  return null;
}

/**
 * Insert unknown series prefixes (ON CONFLICT DO NOTHING).
 * Does not overwrite existing display_name.
 */
export async function ensurePokemonSeriesPrefixes(
  admin: SupabaseClient,
  prefixes: string[],
): Promise<void> {
  const upper = [
    ...new Set(
      prefixes.map((p) => p.trim().toUpperCase()).filter((p) => p.length > 0),
    ),
  ];
  if (upper.length === 0) return;
  const rows = upper.map((series_prefix) => ({ series_prefix }));
  const { error } = await admin.from("pokemon_series_display").upsert(
    rows,
    { onConflict: "series_prefix", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

/**
 * For each stored prefix that matches a TCGdex series id (case-insensitive), set display_name.
 */
export async function syncPokemonSeriesDisplayFromTcgdex(
  admin: SupabaseClient,
  briefs: TcgdexSerieBrief[],
): Promise<{ rowsUpdated: number }> {
  const nameById = tcgdexSeriesNameByIdLower(briefs);
  const { data: rows, error } = await admin
    .from("pokemon_series_display")
    .select("series_prefix");
  if (error) throw new Error(error.message);

  const now = new Date().toISOString();
  const updates: {
    series_prefix: string;
    display_name: string;
    tcgdex_series_id: string;
    enriched_at: string;
  }[] = [];

  for (const r of rows ?? []) {
    const prefix = String((r as { series_prefix?: string }).series_prefix ?? "")
      .trim();
    if (!prefix) continue;
    const name = nameById.get(prefix.toLowerCase());
    if (!name) continue;
    const canon = tcgdexCanonicalIdForPrefix(briefs, prefix) ?? prefix.toLowerCase();
    updates.push({
      series_prefix: prefix,
      display_name: name,
      tcgdex_series_id: canon,
      enriched_at: now,
    });
  }

  if (updates.length === 0) return { rowsUpdated: 0 };

  const chunkSize = 80;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const { error: uErr } = await admin.from("pokemon_series_display").upsert(
      chunk,
      { onConflict: "series_prefix" },
    );
    if (uErr) throw new Error(uErr.message);
  }
  return { rowsUpdated: updates.length };
}
