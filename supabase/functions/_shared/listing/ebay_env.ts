/**
 * Production eBay hosts by default (`api.ebay.com`, `auth.ebay.com`).
 * Sandbox when `EBAY_USE_SANDBOX=true` / `1` / `yes`, or when Client ID contains `-SBX-`
 * (eBay Sandbox App IDs). Set `EBAY_USE_SANDBOX=false` to force production even with `-SBX-`
 * (rare). Production keys: omit sandbox flag and use a non-Sandbox Client ID.
 */
export function ebayUseSandbox(): boolean {
  const raw = Deno.env.get("EBAY_USE_SANDBOX") ?? Deno.env.get("EBAY_SANDBOX");
  if (raw != null && String(raw).trim() !== "") {
    const v = String(raw).trim();
    if (v === "0" || /^false$/i.test(v) || /^no$/i.test(v)) return false;
    if (v === "1" || /^true$/i.test(v) || /^yes$/i.test(v)) return true;
  }
  const appId =
    Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID") ?? "";
  return appId.includes("-SBX-");
}

export function ebayApiOrigin(): string {
  return ebayUseSandbox() ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

export function ebayAuthAuthorizeBase(): string {
  return ebayUseSandbox()
    ? "https://auth.sandbox.ebay.com/oauth2/authorize"
    : "https://auth.ebay.com/oauth2/authorize";
}

export function ebayOAuthTokenUrl(): string {
  return `${ebayApiOrigin()}/identity/v1/oauth2/token`;
}

/**
 * User (authorization code) OAuth scopes. eBay requires the `/oauth/api_scope/...` path;
 * `.../oauth/sell.inventory` is invalid and returns invalid_scope.
 * Override with EBAY_OAUTH_SCOPES (space-separated) from Developer Portal → User Tokens → sample.
 */
export function ebayUserOAuthScopeString(): string {
  const custom = Deno.env.get("EBAY_OAUTH_SCOPES")?.trim();
  if (custom) return custom;
  return [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
  ].join(" ");
}
