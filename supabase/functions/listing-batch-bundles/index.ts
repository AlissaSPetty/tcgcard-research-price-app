import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { partitionForListing } from "../_shared/listing/bundling.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );

  const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({})) as { batchId?: string };
  if (!body.batchId) {
    return new Response(JSON.stringify({ error: "batchId required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const admin = serviceClient();

  const { data: batch, error: be } = await admin
    .from("lp_listing_batches")
    .select("id, user_id")
    .eq("id", body.batchId)
    .single();

  if (be || !batch || batch.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Batch not found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: cards, error: ce } = await admin
    .from("lp_cards")
    .select("id, unit_price_cents, bundle_id, title_hint")
    .eq("batch_id", body.batchId)
    .eq("user_id", user.id)
    .eq("status", "pending_bundle");

  if (ce || !cards?.length) {
    return new Response(JSON.stringify({ groups: 0, message: "No pending_bundle cards" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Detach from old bundles in this batch
  const bundleIds = [...new Set(cards.map((c) => c.bundle_id).filter(Boolean))] as string[];
  if (bundleIds.length) {
    await admin.from("lp_cards").update({ bundle_id: null }).eq("batch_id", body.batchId);
    await admin.from("lp_bundles").delete().in("id", bundleIds);
  }

  const inputs = cards.map((c) => ({
    id: c.id,
    unitPriceCents: Math.max(0, c.unit_price_cents ?? 0),
  }));

  const groups = partitionForListing(inputs);

  let multiBundles = 0;
  let singles = 0;

  for (const g of groups) {
    if (g.cardIds.length === 1) {
      await admin.from("lp_cards").update({
        bundle_id: null,
        status: "ready_draft",
        updated_at: new Date().toISOString(),
      }).eq("id", g.cardIds[0]);
      singles++;
    } else {
      const titleParts = g.cardIds.map((id) => {
        const c = cards.find((x) => x.id === id);
        return c?.title_hint ?? id.slice(0, 6);
      });
      const titleHint = `Lot: ${titleParts.join("; ").slice(0, 75)}`;

      const { data: b, error: insE } = await admin
        .from("lp_bundles")
        .insert({
          user_id: user.id,
          batch_id: body.batchId,
          draft_price_cents: g.listPriceCents,
          title_hint: titleHint,
          status: "ready_draft",
        })
        .select("id")
        .single();

      if (insE || !b) continue;

      await admin.from("lp_cards").update({
        bundle_id: b.id,
        status: "ready_draft",
        updated_at: new Date().toISOString(),
      }).in("id", g.cardIds);
      multiBundles++;
    }
  }

  return new Response(
    JSON.stringify({
      groups: groups.length,
      multiBundles,
      singles,
    }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
