/**
 * Sandbox vs production hosts. Set EBAY_USE_SANDBOX=true when using sandbox keys
 * (App ID / Cert ID from the Sandbox section in developer.ebay.com).
 */
export function ebayUseSandbox(): boolean {
  const v = Deno.env.get("EBAY_USE_SANDBOX") ?? Deno.env.get("EBAY_SANDBOX");
  if (v == null || v === "") return false;
  return v === "1" || /^true$/i.test(v) || /^yes$/i.test(v);
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
