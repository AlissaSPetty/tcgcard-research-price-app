import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { PokemonCardCompSource } from "../_shared/listing/market_comps.ts";
import { ingestOneCardSoldComps } from "../_shared/listing/market_sold_comps_ingest_card.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { maintenanceGate } from "../_shared/maintenance.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

/** Dashboard requests refresh when sold comps are older than this (Finding API → DB). */
const HOT_MOVER_STALE_MS = 30 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function authOk(req: Request): Promise<boolean> {
  const cron =
    Deno.env.get("LISTING_CRON_SECRET") ??
      Deno.env.get("MARKET_SOLD_COMPS_CRON_SECRET");
  const secretHeader = req.headers.get("x-cron-secret");
  if (cron && secretHeader === cron) return true;

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const bearer = auth.slice(7);
  if (cron && bearer === cron) return true;

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseUser = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error } = await supabaseUser.auth.getUser();
  return !error && !!user;
}

function ebayAppIdOnly(): string | null {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  if (!appId?.trim()) return null;
  return appId.trim();
}

async function refreshStaleHotCards(
  admin: ReturnType<typeof serviceClient>,
  appId: string,
  staleIds: string[],
): Promise<void> {
  const rawFinding = Number(
    Deno.env.get("MARKET_SOLD_COMPS_FINDING_LIMIT") ?? "100",
  );
  const findingLimit = Math.min(
    100,
    Math.max(1, Number.isFinite(rawFinding) ? rawFinding : 100),
  );
  const delayMs = Math.max(
    0,
    Number(Deno.env.get("MARKET_SOLD_COMPS_SEARCH_DELAY_MS") ?? "0"),
  );

  for (const id of staleIds) {
    const { data: cardRow, error: cardErr } = await admin
      .from("pokemon_card_images")
      .select(
        "id, name, card_set, card_number, tcgplayer_prices_by_finish, tcgplayer_price_cents",
      )
      .eq("id", id)
      .maybeSingle();

    if (cardErr || !cardRow) continue;

    const card = cardRow as PokemonCardCompSource;

    const { data: tierRow } = await admin
      .from("pokemon_card_market_refresh")
      .select("refresh_tier")
      .eq("pokemon_card_image_id", id)
      .maybeSingle();

    const refreshTier =
      (tierRow?.refresh_tier as string | undefined)?.trim() || "normal";

    await ingestOneCardSoldComps(admin, appId, card, {
      findingLimit,
      delayMs,
      recordSnapshots: false,
      refreshTier,
    });

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

Deno.serve(async (req) => {
  const maintenance = maintenanceGate(req, cors);
  if (maintenance) return maintenance;

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!(await authOk(req))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { pokemon_card_image_ids?: unknown } = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const rawIds = body.pokemon_card_image_ids;
  if (!Array.isArray(rawIds)) {
    return json({ error: "Missing pokemon_card_image_ids array" }, 400);
  }

  const ids = rawIds
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, 48);

  if (ids.length === 0) {
    return json({ error: "No valid pokemon_card_image_ids" }, 400);
  }

  const appId = ebayAppIdOnly();
  if (!appId) {
    return json(
      { error: "Missing EBAY_APP_ID (or EBAY_CLIENT_ID) for Finding API" },
      500,
    );
  }

  const admin = serviceClient();
  const now = Date.now();

  const { data: rows, error: qErr } = await admin
    .from("market_sold_comps")
    .select("pokemon_card_image_id, updated_at")
    .in("pokemon_card_image_id", ids);

  if (qErr) {
    return json({ error: qErr.message }, 500);
  }

  const newestByCard = new Map<string, number>();
  for (const r of rows ?? []) {
    const pid = (r as { pokemon_card_image_id?: string }).pokemon_card_image_id;
    const u = (r as { updated_at?: string }).updated_at;
    if (!pid || !u) continue;
    const t = new Date(String(u)).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = newestByCard.get(pid) ?? 0;
    if (t > prev) newestByCard.set(pid, t);
  }

  const staleIds: string[] = [];
  for (const id of ids) {
    const newest = newestByCard.get(id);
    if (newest == null || now - newest > HOT_MOVER_STALE_MS) {
      staleIds.push(id);
    }
  }

  if (staleIds.length === 0) {
    return json({
      ok: true,
      accepted: false,
      staleCount: 0,
      message: "All requested cards have fresh sold comps",
    });
  }

  const bg = refreshStaleHotCards(admin, appId, staleIds);
  const edgeRt =
    (globalThis as Record<string, { waitUntil: (p: Promise<unknown>) => void }>).EdgeRuntime;
  if (edgeRt?.waitUntil) {
    edgeRt.waitUntil(bg);
  } else {
    void bg.catch((e) => console.error("[market-sold-comps-hot-refresh]", e));
  }

  return json(
    {
      ok: true,
      accepted: true,
      staleCount: staleIds.length,
      refreshingIds: staleIds,
    },
    202,
  );
});
