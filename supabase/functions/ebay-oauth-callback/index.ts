import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { ebayOAuthTokenUrl } from "../_shared/listing/ebay_env.ts";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const err = u.searchParams.get("error");

  const html = (body: string) =>
    new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>eBay</title></head><body><p>${body}</p><p><a href="/">Back to app</a></p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );

  if (err) {
    return html(`eBay OAuth error: ${err}`);
  }
  if (!code || !state) {
    return html("Missing code or state");
  }

  const admin = serviceClient();
  const { data: st } = await admin
    .from("lp_oauth_states")
    .select("user_id")
    .eq("id", state)
    .maybeSingle();

  if (!st?.user_id) {
    return html("Invalid or expired OAuth state");
  }

  const clientId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  const clientSecret = Deno.env.get("EBAY_CERT_ID") ??
    Deno.env.get("EBAY_CLIENT_SECRET");
  const redirectUri =
    Deno.env.get("EBAY_OAUTH_REDIRECT_URL") ??
    `${Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "")}/functions/v1/ebay-oauth-callback`;

  if (!clientId || !clientSecret) {
    return html("Server missing eBay credentials");
  }

  const basic = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const tokRes = await fetch(ebayOAuthTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!tokRes.ok) {
    const t = await tokRes.text();
    return html(`Token exchange failed: ${t}`);
  }

  const tok = await tokRes.json() as {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    refresh_token_expires_in?: number;
  };

  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();

  await admin.from("lp_oauth_states").delete().eq("id", state);

  await admin.from("lp_ebay_accounts").upsert(
    {
      user_id: st.user_id,
      refresh_token_encrypted: tok.refresh_token,
      access_token_cached: tok.access_token,
      access_token_expires_at: expiresAt,
      scopes:
        "sell.inventory sell.account",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  return html("eBay connected. You can close this tab and return to the listing admin.");
});
