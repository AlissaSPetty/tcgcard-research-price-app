import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { ebayClientCredentialsToken } from "../_shared/listing/ebay_market.ts";
import type { PokemonCardCompSource } from "../_shared/listing/market_comps.ts";
import { ingestOneCardSoldComps } from "../_shared/listing/market_sold_comps_ingest_card.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { maintenanceGate } from "../_shared/maintenance.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

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

/** Finding API uses App ID only (not OAuth client-credentials). */
function ebayAppIdOnly(): string | null {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  if (!appId?.trim()) return null;
  return appId.trim();
}

/** Browse API fallback (same keys as `market-comps-card-fetch`). */
function ebayAppCredentials(): { appId: string; certId: string } | null {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  const certId =
    Deno.env.get("EBAY_CERT_ID") ?? Deno.env.get("EBAY_CLIENT_SECRET");
  if (!appId?.trim() || !certId?.trim()) return null;
  return { appId: appId.trim(), certId: certId.trim() };
}

function cooldownMinutes(): number {
  const raw = Deno.env.get("MARKET_SOLD_COMPS_CARD_COOLDOWN_MINUTES")?.trim();
  const n = raw ? Number(raw) : 60;
  return Number.isFinite(n) && n >= 0 ? Math.min(24 * 60, Math.max(0, n)) : 60;
}

async function selectSoldRows(
  admin: ReturnType<typeof serviceClient>,
  pokemonCardImageId: string,
) {
  const { data, error } = await admin
    .from("market_sold_comps")
    .select(
      "id, pokemon_card_image_id, card_type, average_price_cents, sample_size, updated_at",
    )
    .eq("pokemon_card_image_id", pokemonCardImageId)
    .order("card_type", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
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

  let body: { pokemon_card_image_id?: string; force?: boolean } = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const id =
    typeof body.pokemon_card_image_id === "string"
      ? body.pokemon_card_image_id.trim()
      : "";
  const force = Boolean(body.force);
  if (!id) {
    return json({ error: "Missing pokemon_card_image_id" }, 400);
  }

  const cdMin = cooldownMinutes();
  const cooldownMs = cdMin * 60 * 1000;
  const admin = serviceClient();

  const { data: latest, error: latestErr } = await admin
    .from("market_sold_comps")
    .select("updated_at")
    .eq("pokemon_card_image_id", id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    return json({ error: latestErr.message }, 500);
  }

  const latestAt = latest?.updated_at
    ? new Date(String(latest.updated_at)).getTime()
    : null;

  if (
    !force &&
    latestAt != null &&
    Number.isFinite(latestAt) &&
    Date.now() - latestAt < cooldownMs
  ) {
    try {
      const rows = await selectSoldRows(admin, id);
      const newestMs = rows.reduce((acc, r) => {
        const t = r.updated_at
          ? new Date(String(r.updated_at)).getTime()
          : 0;
        return Math.max(acc, t);
      }, 0);
      return json({
        ok: true,
        cached: true,
        cooldownMinutes: cdMin,
        fetchedAt: newestMs ? new Date(newestMs).toISOString() : null,
        rows,
        errors: [],
      });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  const appId = ebayAppIdOnly();
  if (!appId) {
    return json(
      { error: "Missing EBAY_APP_ID (or EBAY_CLIENT_ID) for Finding API" },
      500,
    );
  }

  const { data: cardRow, error: cardErr } = await admin
    .from("pokemon_card_images")
    .select("id, name, card_set, card_number, tcgplayer_prices_by_finish, tcgplayer_price_cents")
    .eq("id", id)
    .maybeSingle();

  if (cardErr) {
    return json({ error: cardErr.message }, 500);
  }
  if (!cardRow) {
    return json({ error: "Card not found" }, 404);
  }

  const card = cardRow as PokemonCardCompSource;

  const { data: tierRow } = await admin
    .from("pokemon_card_market_refresh")
    .select("refresh_tier")
    .eq("pokemon_card_image_id", id)
    .maybeSingle();

  const refreshTier =
    (tierRow?.refresh_tier as string | undefined)?.trim() || "normal";

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

  let browseFallbackToken: string | undefined;
  const creds = ebayAppCredentials();
  if (creds) {
    try {
      browseFallbackToken = await ebayClientCredentialsToken(
        creds.appId,
        creds.certId,
      );
    } catch {
      browseFallbackToken = undefined;
    }
  }

  const result = await ingestOneCardSoldComps(admin, appId, card, {
    findingLimit,
    delayMs,
    recordSnapshots: false,
    refreshTier,
    browseFallbackToken,
  });

  try {
    const rows = await selectSoldRows(admin, id);
    const newestMs = rows.reduce((acc, r) => {
      const t = r.updated_at ? new Date(String(r.updated_at)).getTime() : 0;
      return Math.max(acc, t);
    }, 0);
    const soldBrowseFallbackUsed = (result.findingDiagnostics ?? []).some(
      (d) => d.raw?.source === "browse_bin_fallback",
    );
    return json({
      ok: true,
      cached: false,
      cooldownMinutes: cdMin,
      fetchedAt: newestMs ? new Date(newestMs).toISOString() : new Date()
        .toISOString(),
      rows,
      searches: result.searches,
      rowsUpserted: result.rowsUpserted,
      errors: result.errors,
      findingDiagnostics: result.findingDiagnostics ?? [],
      soldBrowseFallbackUsed,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
