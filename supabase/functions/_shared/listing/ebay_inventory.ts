import { ebayApiOrigin, ebayOAuthTokenUrl } from "./ebay_env.ts";

function sellInventoryV1(): string {
  return `${ebayApiOrigin()}/sell/inventory/v1`;
}

function ebayJsonHeaders(token: string, includeAcceptLanguage = true): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Language": "en-US",
    ...(includeAcceptLanguage ? { "Accept-Language": "en-US" } : {}),
  };
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function hasInvalidAcceptLanguageError(body: string): boolean {
  return body.includes('"errorId":25709') ||
    body.includes("Invalid value for header Accept-Language");
}

function errorLabelFor(method: "POST" | "PUT"): string {
  return method === "PUT" ? "putInventoryItem" : "createOffer";
}

async function fetchEbayWithLocaleFallback(
  url: string,
  method: "POST" | "PUT",
  token: string,
  body: unknown,
): Promise<Response> {
  const bodyStr = JSON.stringify(body);
  let res = await fetch(url, {
    method,
    headers: ebayJsonHeaders(token, true),
    body: bodyStr,
  });
  if (res.ok || res.status === 204) return res;

  const firstBody = await readBody(res);
  if (!hasInvalidAcceptLanguageError(firstBody)) {
    throw new Error(`${errorLabelFor(method)} ${res.status}: ${firstBody}`);
  }

  // Retry once with only Content-Language.
  res = await fetch(url, {
    method,
    headers: ebayJsonHeaders(token, false),
    body: bodyStr,
  });
  if (res.ok || res.status === 204) return res;

  const secondBody = await readBody(res);
  throw new Error(`${errorLabelFor(method)} ${res.status}: ${secondBody}`);
}

export async function refreshUserAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(ebayOAuthTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`eBay user token refresh failed: ${res.status} ${t}`);
  }
  return res.json();
}

export interface CreateInventoryItemInput {
  sku: string;
  title: string;
  imageUrls: string[];
  condition?: string;
  aspects?: Record<string, string[]>;
}

export async function putInventoryItem(
  token: string,
  input: CreateInventoryItemInput,
): Promise<void> {
  const url = `${sellInventoryV1()}/inventory_item/${encodeURIComponent(input.sku)}`;
  const body = {
    condition: input.condition ?? "USED_EXCELLENT",
    availability: {
      shipToLocationAvailability: { quantity: 1 },
    },
    product: {
      title: input.title,
      imageUrls: input.imageUrls,
      ...(input.aspects ? { aspects: input.aspects } : {}),
    },
  };
  const res = await fetchEbayWithLocaleFallback(url, "PUT", token, body);
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw new Error(`putInventoryItem ${res.status}: ${t}`);
  }
}

export interface CreateOfferInput {
  sku: string;
  marketplaceId: string;
  merchantLocationKey: string;
  categoryId: string;
  pricingValue: string; // "4.99"
  currency: string;
  listingDescription: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

export async function createOffer(
  token: string,
  input: CreateOfferInput,
): Promise<{ offerId: string }> {
  const url = `${sellInventoryV1()}/offer`;
  const body = {
    sku: input.sku,
    marketplaceId: input.marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: input.categoryId,
    merchantLocationKey: input.merchantLocationKey,
    listingDescription: input.listingDescription,
    listingPolicies: {
      fulfillmentPolicyId: input.fulfillmentPolicyId,
      paymentPolicyId: input.paymentPolicyId,
      returnPolicyId: input.returnPolicyId,
    },
    pricingSummary: {
      price: { value: input.pricingValue, currency: input.currency },
    },
  };
  const res = await fetchEbayWithLocaleFallback(url, "POST", token, body);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`createOffer ${res.status}: ${t}`);
  }
  const j = await res.json();
  return { offerId: j.offerId };
}

export async function publishOffer(
  token: string,
  offerId: string,
): Promise<{ listingId: string }> {
  const url = `${sellInventoryV1()}/offer/${encodeURIComponent(offerId)}/publish`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`publishOffer ${res.status}: ${t}`);
  }
  const j = await res.json();
  return { listingId: j.listingId };
}

export async function withdrawOffer(token: string, offerId: string): Promise<void> {
  const url = `${sellInventoryV1()}/offer/${encodeURIComponent(offerId)}/withdraw`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw new Error(`withdrawOffer ${res.status}: ${t}`);
  }
}

export async function updateOfferPrice(
  token: string,
  offerId: string,
  value: string,
  currency: string,
): Promise<void> {
  const getUrl = `${sellInventoryV1()}/offer/${encodeURIComponent(offerId)}`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!getRes.ok) {
    const t = await getRes.text();
    throw new Error(`getOffer ${getRes.status}: ${t}`);
  }
  const offer = await getRes.json();
  offer.pricingSummary = {
    ...offer.pricingSummary,
    price: { value, currency },
  };
  const putRes = await fetch(getUrl, {
    method: "PUT",
    headers: ebayJsonHeaders(token),
    body: JSON.stringify(offer),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`updateOffer ${putRes.status}: ${t}`);
  }
}
