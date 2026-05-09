import { supabase } from "./supabaseClient";

export type CatalogStatusRow = {
  generation: number;
  ingest_running: boolean;
};

export const LISTING_CATALOG_STATUS_QUERY_KEY = ["listing-catalog-status"] as const;

export async function fetchListingCatalogStatus(): Promise<CatalogStatusRow | null> {
  const { data, error: rpcErr } = await supabase.rpc("listing_catalog_status");
  if (rpcErr) return null;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") return null;
  const rec = row as { generation?: number; ingest_running?: boolean };
  if (typeof rec.generation !== "number" || typeof rec.ingest_running !== "boolean") {
    return null;
  }
  return { generation: rec.generation, ingest_running: rec.ingest_running };
}
