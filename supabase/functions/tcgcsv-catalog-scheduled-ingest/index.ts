import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { maintenanceGate } from "../_shared/maintenance.ts";

/**
 * Calls pokemon-card-images-ingest repeatedly until tcgcsv groups are fully processed
 * (same behavior as listing-pipeline/cli/refresh-pokemon-card-images.ts).
 *
 * Intended for pg_cron / CI: POST with x-cron-secret only (no user JWT).
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type PokemonIngestResponse = {
  ok?: boolean;
  partial?: boolean;
  done?: boolean;
  nextStartGroupIndex?: number | null;
  rowsUpserted?: number;
  startGroupIndex?: number;
  endGroupIndex?: number;
  totalGroups?: number;
  errors?: string[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function cronSecret(): string | undefined {
  return (
    Deno.env.get("LISTING_CRON_SECRET")?.trim() ||
    Deno.env.get("POKEMON_CARD_IMAGES_CRON_SECRET")?.trim() ||
    undefined
  );
}

function authOk(req: Request): boolean {
  const cron = cronSecret();
  if (!cron) return false;
  const header = req.headers.get("x-cron-secret");
  if (header === cron) return true;
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === cron) return true;
  return false;
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

  if (!cronSecret()) {
    return json(
      {
        error:
          "LISTING_CRON_SECRET (or POKEMON_CARD_IMAGES_CRON_SECRET) is not configured",
      },
      500,
    );
  }

  if (!authOk(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const cron = cronSecret()!;
  const maxBatches = Math.min(
    10_000,
    Math.max(
      1,
      Number(
        Deno.env.get("TCGCSV_CATALOG_ORCHESTRATOR_MAX_BATCHES") ?? "2000",
      ),
    ),
  );

  let startGroupIndex = 0;
  let fullNightlyRerun = false;
  try {
    const t = await req.text();
    if (t) {
      const body = JSON.parse(t) as {
        startGroupIndex?: number;
        fullNightlyRerun?: boolean;
      };
      if (
        typeof body?.startGroupIndex === "number" &&
        Number.isFinite(body.startGroupIndex) &&
        body.startGroupIndex >= 0
      ) {
        startGroupIndex = Math.floor(body.startGroupIndex);
      }
      fullNightlyRerun = body?.fullNightlyRerun === true;
    }
  } catch {
    startGroupIndex = 0;
    fullNightlyRerun = false;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  if (!supabaseUrl) {
    return json({ error: "SUPABASE_URL is not set" }, 500);
  }

  const ingestUrl = `${supabaseUrl}/functions/v1/pokemon-card-images-ingest`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-cron-secret": cron,
  };

  let batch = 0;
  let totalRowsUpserted = 0;
  const batchSummaries: Array<{
    batch: number;
    startGroupIndex?: number;
    endGroupIndex?: number;
    rowsUpserted?: number;
    totalGroups?: number;
  }> = [];

  for (;;) {
    batch++;
    if (batch > maxBatches) {
      return json(
        {
          ok: false,
          error: `Stopped after ${maxBatches} batches (TCGCSV_CATALOG_ORCHESTRATOR_MAX_BATCHES)`,
          batchesRun: batch - 1,
          totalRowsUpserted,
          nextStartGroupIndex: startGroupIndex,
          batchSummaries,
        },
        500,
      );
    }

    const prevStart = startGroupIndex;
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        startGroupIndex,
        fullNightlyRerun,
        emergencyBatch: false,
      }),
    });

    const text = await res.text();
    let parsed: PokemonIngestResponse;
    try {
      parsed = JSON.parse(text) as PokemonIngestResponse;
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON from pokemon-card-images-ingest",
          httpStatus: res.status,
          bodyPreview: text.slice(0, 800),
        },
        502,
      );
    }

    batchSummaries.push({
      batch,
      startGroupIndex: parsed.startGroupIndex,
      endGroupIndex: parsed.endGroupIndex,
      rowsUpserted: parsed.rowsUpserted,
      totalGroups: parsed.totalGroups,
    });

    if (!res.ok) {
      return json(
        {
          ok: false,
          httpStatus: res.status,
          batchesRun: batch,
          totalRowsUpserted,
          lastResponse: parsed,
          batchSummaries,
        },
        502,
      );
    }

    totalRowsUpserted += parsed.rowsUpserted ?? 0;

    if (parsed.done === true) {
      return json({
        ok: true,
        done: true,
        batchesRun: batch,
        totalRowsUpserted,
        totalGroups: parsed.totalGroups,
        lastResponse: parsed,
        batchSummaries,
      });
    }

    const next = parsed.nextStartGroupIndex;
    if (next == null || next < 0) {
      return json({
        ok: true,
        done: true,
        batchesRun: batch,
        totalRowsUpserted,
        note: "Ingest returned done=false but no nextStartGroupIndex",
        lastResponse: parsed,
        batchSummaries,
      });
    }

    if (next === prevStart) {
      return json(
        {
          ok: false,
          error:
            "Progress stalled: nextStartGroupIndex equals previous startGroupIndex",
          nextStartGroupIndex: next,
          batchesRun: batch,
          batchSummaries,
        },
        500,
      );
    }

    startGroupIndex = next;
  }
});
