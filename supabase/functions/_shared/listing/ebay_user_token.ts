import {
  refreshUserAccessToken,
} from "./ebay_inventory.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export async function ensureUserAccessToken(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID")!;
  const appSecret = Deno.env.get("EBAY_CERT_ID") ??
    Deno.env.get("EBAY_CLIENT_SECRET")!;

  const { data: acct, error } = await admin
    .from("lp_ebay_accounts")
    .select(
      "refresh_token_encrypted, access_token_cached, access_token_expires_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !acct?.refresh_token_encrypted) {
    throw new Error("eBay not connected for this user");
  }

  const exp = acct.access_token_expires_at
    ? new Date(acct.access_token_expires_at).getTime()
    : 0;
  if (acct.access_token_cached && exp > Date.now() + 60_000) {
    return acct.access_token_cached;
  }

  const tok = await refreshUserAccessToken(
    acct.refresh_token_encrypted,
    appId,
    appSecret,
  );

  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000)
    .toISOString();
  const newRefresh = tok.refresh_token ?? acct.refresh_token_encrypted;

  await admin
    .from("lp_ebay_accounts")
    .update({
      access_token_cached: tok.access_token,
      access_token_expires_at: expiresAt,
      refresh_token_encrypted: newRefresh,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  return tok.access_token;
}
