import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { ebayAuthAuthorizeBase, ebayUserOAuthScopeString } from "../_shared/listing/ebay_env.ts";

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

  const supabaseAnon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );

  const { data: { user }, error: userErr } = await supabaseAnon.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const clientId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  const runUrl =
    Deno.env.get("EBAY_OAUTH_REDIRECT_URL") ??
    `${Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "")}/functions/v1/ebay-oauth-callback`;

  if (!clientId) {
    return new Response(
      JSON.stringify({
        error: "Missing EBAY_APP_ID (eBay Client ID)",
      }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const admin = serviceClient();
  const { data: stateRow, error: stErr } = await admin
    .from("lp_oauth_states")
    .insert({ user_id: user.id })
    .select("id")
    .single();

  if (stErr || !stateRow) {
    return new Response(JSON.stringify({ error: "Could not start OAuth", details: stErr }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const scope = encodeURIComponent(ebayUserOAuthScopeString());
  const url =
    `${ebayAuthAuthorizeBase()}?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(runUrl)}` +
    `&scope=${scope}&state=${stateRow.id}`;

  return new Response(JSON.stringify({ url }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
