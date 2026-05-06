import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  mapTcgcsvProductToRow,
  tcgcsvFinishPriceMapFromResults,
  tcgcsvPriceRowMapFromResults,
  tcgcsvSeriesPrefixFromGroupName,
  type TcgcsvGroup,
  type TcgcsvPriceDetail,
} from "../_shared/listing/tcgcsv_product.ts";
import {
  ensurePokemonSeriesPrefixes,
  fetchTcgdexSeriesBriefs,
  syncPokemonSeriesDisplayFromTcgdex,
} from "../_shared/listing/tcgdex_series.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

/** Default: Pokémon category on tcgcsv (TCGPlayer categoryId = 3). */
const DEFAULT_TCGCSV_BASE = "https://tcgcsv.com/tcgplayer/3";
/** Smaller chunks reduce memory spikes (helps avoid Edge WORKER_LIMIT). */
const UPSERT_CHUNK = 50;

type TcgcsvListPayload = {
  success?: boolean;
  results?: unknown[];
  totalItems?: number;
  errors?: unknown[];
};

type TcgplayerSnapshotInsert = {
  pokemon_card_image_id: string | null;
  tcgplayer_product_id: number;
  sub_type_name: string;
  market_price_cents: number | null;
  low_price_cents: number | null;
  high_price_cents: number | null;
  direct_low_price_cents: number | null;
  ingested_at: string;
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

function jsonHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "User-Agent": "tcgcard-research-price-app/1.0",
  };
}

async function fetchJson(url: string): Promise<TcgcsvListPayload> {
  const res = await fetch(url, { headers: jsonHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as TcgcsvListPayload;
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

  let body: { startGroupIndex?: number; groupsPerRun?: number } = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as typeof body;
  } catch {
    body = {};
  }

  const base = (
    Deno.env.get("TCGCSV_CATEGORY_BASE")?.trim() || DEFAULT_TCGCSV_BASE
  ).replace(/\/$/, "");

  const groupsPerRun = Math.min(
    500,
    Math.max(
      1,
      Number(Deno.env.get("POKEMON_CARD_IMAGES_GROUPS_PER_RUN") ?? "4"),
    ),
  );
  const startGroupIndex = Math.max(
    0,
    Math.floor(Number(body.startGroupIndex ?? 0)),
  );
  const runCount = Math.min(
    500,
    Math.max(1, Number(body.groupsPerRun ?? groupsPerRun)),
  );

  const delayMs = Math.max(
    0,
    Number(Deno.env.get("POKEMON_CARD_IMAGES_GROUP_DELAY_MS") ?? "150"),
  );

  const admin = serviceClient();
  const errors: string[] = [];
  let rowsUpserted = 0;

  let allGroups: TcgcsvGroup[] = [];
  try {
    const gPayload = await fetchJson(`${base}/groups`);
    const raw = gPayload.results ?? [];
    if (!Array.isArray(raw)) {
      return json(
        { ok: false, errors: ["tcgcsv groups: invalid results array"] },
        500,
      );
    }
    allGroups = raw
      .map((r) => {
        const o = r as Record<string, unknown>;
        const groupId = o.groupId;
        if (groupId == null) return null;
        const id = Number(groupId);
        if (!Number.isFinite(id)) return null;
        return {
          groupId: id,
          name: String(o.name ?? "").trim() || `Group ${id}`,
          publishedOn: o.publishedOn != null
            ? String(o.publishedOn)
            : undefined,
        } as TcgcsvGroup;
      })
      .filter((g): g is TcgcsvGroup => g != null);
  } catch (e) {
    return json(
      {
        ok: false,
        errors: [`fetch_groups: ${(e as Error).message}`],
        sourceBase: base,
      },
      500,
    );
  }

  const totalGroups = allGroups.length;
  if (totalGroups === 0) {
    return json({
      ok: true,
      sourceBase: base,
      totalGroups: 0,
      startGroupIndex: 0,
      endGroupIndex: -1,
      groupsProcessed: 0,
      rowsUpserted: 0,
      nextStartGroupIndex: null,
      done: true,
      errors: [],
    });
  }

  const seriesPrefixes = [
    ...new Set(
      allGroups
        .map((g) => tcgcsvSeriesPrefixFromGroupName(g.name))
        .filter((x): x is string => !!x),
    ),
  ];
  try {
    await ensurePokemonSeriesPrefixes(admin, seriesPrefixes);
    const briefs = await fetchTcgdexSeriesBriefs();
    await syncPokemonSeriesDisplayFromTcgdex(admin, briefs);
  } catch (e) {
    // Non-fatal: catalog ingest must succeed if tcgcsv is up; labels fall back to prefix in UI.
    console.error("tcgdex_series_display:", (e as Error).message);
  }

  const endIdxExclusive = Math.min(
    startGroupIndex + runCount,
    totalGroups,
  );
  if (startGroupIndex >= totalGroups) {
    return json({
      ok: true,
      sourceBase: base,
      totalGroups,
      startGroupIndex,
      endGroupIndex: totalGroups - 1,
      groupsProcessed: 0,
      rowsUpserted: 0,
      nextStartGroupIndex: null,
      done: true,
      errors: ["startGroupIndex is past the end of the group list"],
    });
  }

  for (let gi = startGroupIndex; gi < endIdxExclusive; gi++) {
    const group = allGroups[gi]!;
    let prodPayload: TcgcsvListPayload;
    try {
      prodPayload = await fetchJson(`${base}/${group.groupId}/products`);
    } catch (e) {
      errors.push(
        `group_${group.groupId}_fetch: ${(e as Error).message}`,
      );
      if (delayMs > 0 && gi + 1 < endIdxExclusive) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      continue;
    }

    let priceByProductId = new Map<number, Record<string, unknown>>();
    let finishPriceByProductId = new Map<
      number,
      Record<string, TcgcsvPriceDetail>
    >();
    try {
      const pricePayload = await fetchJson(`${base}/${group.groupId}/prices`);
      const priceResults = pricePayload.results ?? [];
      if (Array.isArray(priceResults)) {
        priceByProductId = tcgcsvPriceRowMapFromResults(priceResults);
        finishPriceByProductId = tcgcsvFinishPriceMapFromResults(priceResults);
      } else {
        errors.push(`group_${group.groupId}_prices: not an array`);
      }
    } catch (e) {
      console.error(
        `group_${group.groupId}_prices_fetch:`,
        (e as Error).message,
      );
    }

    const products = prodPayload.results ?? [];
    if (!Array.isArray(products)) {
      errors.push(`group_${group.groupId}_products: not an array`);
      if (delayMs > 0 && gi + 1 < endIdxExclusive) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      continue;
    }

    const rows = products
      .map((c) => {
        const rec = c as Record<string, unknown>;
        const pid = Number(rec.productId);
        const priceRow = Number.isFinite(pid) && pid > 0
          ? priceByProductId.get(pid)
          : undefined;
        const priceFinish = Number.isFinite(pid) && pid > 0
          ? finishPriceByProductId.get(pid) ?? null
          : null;
        return mapTcgcsvProductToRow(rec, group, priceRow, priceFinish);
      })
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        ...r,
        updated_at: new Date().toISOString(),
      }));

    const imageIdByProductId = new Map<number, string>();
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { data: upRows, error: upErr } = await admin
        .from("pokemon_card_images")
        .upsert(
          chunk,
          { onConflict: "tcgplayer_product_id" },
        )
        .select("id, tcgplayer_product_id");
      if (upErr) {
        errors.push(`group_${group.groupId}_upsert: ${upErr.message}`);
        return json(
          {
            ok: false,
            sourceBase: base,
            totalGroups,
            startGroupIndex,
            endGroupIndex: endIdxExclusive - 1,
            groupsProcessed: gi - startGroupIndex,
            rowsUpserted,
            errors,
          },
          500,
        );
      }
      for (const row of (upRows ?? []) as Array<{ id: string; tcgplayer_product_id: number }>) {
        if (typeof row.tcgplayer_product_id === "number" && row.id) {
          imageIdByProductId.set(row.tcgplayer_product_id, row.id);
        }
      }
      rowsUpserted += chunk.length;
    }

    // Persist append-only TCGPlayer/tcgcsv price history for charting.
    if (rows.length > 0) {
      const nowIso = new Date().toISOString();
      const snapshots: TcgplayerSnapshotInsert[] = [];
      for (const r of rows) {
        const byFinish = finishPriceByProductId.get(r.tcgplayer_product_id);
        if (byFinish && Object.keys(byFinish).length > 0) {
          for (const [subTypeName, p] of Object.entries(byFinish)) {
            snapshots.push({
              pokemon_card_image_id: imageIdByProductId.get(r.tcgplayer_product_id) ?? null,
              tcgplayer_product_id: r.tcgplayer_product_id,
              sub_type_name: subTypeName,
              market_price_cents: p.market_cents,
              low_price_cents: p.low_cents,
              high_price_cents: p.high_cents,
              direct_low_price_cents: p.direct_cents,
              ingested_at: nowIso,
            });
          }
        } else if (r.tcgplayer_price_cents != null) {
          snapshots.push({
            pokemon_card_image_id: imageIdByProductId.get(r.tcgplayer_product_id) ?? null,
            tcgplayer_product_id: r.tcgplayer_product_id,
            sub_type_name: "Normal",
            market_price_cents: r.tcgplayer_price_cents,
            low_price_cents: null,
            high_price_cents: null,
            direct_low_price_cents: null,
            ingested_at: nowIso,
          });
        }
      }

      for (let i = 0; i < snapshots.length; i += UPSERT_CHUNK) {
        const chunk = snapshots.slice(i, i + UPSERT_CHUNK);
        const { error: snapErr } = await admin
          .from("tcgplayer_price_snapshots")
          .insert(chunk);
        if (snapErr) {
          errors.push(`group_${group.groupId}_price_snapshots: ${snapErr.message}`);
          break;
        }
      }
    }

    if (delayMs > 0 && gi < endIdxExclusive - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const endGroupIndex = endIdxExclusive - 1;
  const nextStart = endIdxExclusive < totalGroups ? endIdxExclusive : null;
  const done = nextStart === null;

  if (errors.length > 0) {
    return json(
      {
        ok: false,
        sourceBase: base,
        totalGroups,
        startGroupIndex,
        endGroupIndex,
        groupsProcessed: endIdxExclusive - startGroupIndex,
        rowsUpserted,
        nextStartGroupIndex: nextStart,
        done,
        errors,
      },
      500,
    );
  }

  return json({
    ok: true,
    sourceBase: base,
    totalGroups,
    startGroupIndex,
    endGroupIndex,
    groupsProcessed: endIdxExclusive - startGroupIndex,
    rowsUpserted,
    nextStartGroupIndex: nextStart,
    done,
    errors: [],
  });
});
