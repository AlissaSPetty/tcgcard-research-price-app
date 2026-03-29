import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { mapPokemonTcgApiCardToRow } from "../_shared/listing/pokemon_tcg_api.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const DEFAULT_API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const UPSERT_CHUNK = 150;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function authOk(req: Request): Promise<boolean> {
  const cron =
    Deno.env.get("LISTING_CRON_SECRET") ??
      Deno.env.get("POKEMON_CARD_IMAGES_CRON_SECRET");
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

function apiHeaders(): HeadersInit {
  const key = Deno.env.get("POKEMONTCG_API_KEY")?.trim();
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  if (key) h["X-Api-Key"] = key;
  return h;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!(await authOk(req))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = serviceClient();
  const baseUrl = (
    Deno.env.get("POKEMON_CARD_IMAGES_SOURCE_URL")?.trim() ||
    DEFAULT_API_BASE
  ).replace(/\/$/, "");

  const maxPages = Math.min(
    500,
    Math.max(
      1,
      Number(Deno.env.get("POKEMON_CARD_IMAGES_MAX_PAGES") ?? "80"),
    ),
  );

  const delayMs = Math.max(
    0,
    Number(Deno.env.get("POKEMON_CARD_IMAGES_PAGE_DELAY_MS") ?? "120"),
  );

  let insertedOrUpdated = 0;
  let pages = 0;
  const errors: string[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(baseUrl);
    if (!u.searchParams.has("pageSize")) {
      u.searchParams.set("pageSize", String(PAGE_SIZE));
    }
    u.searchParams.set("page", String(page));

    let res: Response;
    try {
      res = await fetch(u.toString(), { headers: apiHeaders() });
    } catch (e) {
      errors.push(`fetch_page_${page}: ${(e as Error).message}`);
      break;
    }

    if (!res.ok) {
      errors.push(`http_${page}: ${res.status}`);
      break;
    }

    let payload: { data?: unknown[] };
    try {
      payload = await res.json();
    } catch (e) {
      errors.push(`json_${page}: ${(e as Error).message}`);
      break;
    }

    const raw = payload.data ?? [];
    if (!Array.isArray(raw) || raw.length === 0) {
      break;
    }

    pages = page;
    const rows = raw
      .map((c) =>
        mapPokemonTcgApiCardToRow(c as Record<string, unknown>)
      )
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        ...r,
        updated_at: new Date().toISOString(),
      }));

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { error: upErr } = await admin.from("pokemon_card_images").upsert(
        chunk,
        { onConflict: "external_id" },
      );
      if (upErr) {
        errors.push(upErr.message);
        return json({ ok: false, errors, pages, insertedOrUpdated }, 500);
      }
      insertedOrUpdated += chunk.length;
    }

    if (raw.length < PAGE_SIZE) break;

    if (delayMs > 0 && page < maxPages) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return json({
    ok: true,
    sourceUrl: baseUrl,
    pagesFetched: pages,
    rowsUpserted: insertedOrUpdated,
    errors,
  });
});
