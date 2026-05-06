/** Cadence after a successful comp ingest pass, by tier (hot = volatile). */
const TIER_DAYS_ACTIVE: Record<string, number> = {
  hot: 1,
  normal: 3,
  cold: 14,
};

const TIER_DAYS_SOLD: Record<string, number> = {
  hot: 1,
  normal: 3,
  cold: 14,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function nextActiveRefreshAtIso(refreshTier: string | null | undefined): string {
  const tier = (refreshTier ?? "normal").toLowerCase();
  const days = TIER_DAYS_ACTIVE[tier] ?? TIER_DAYS_ACTIVE.normal;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export function nextSoldRefreshAtIso(refreshTier: string | null | undefined): string {
  const tier = (refreshTier ?? "normal").toLowerCase();
  const days = TIER_DAYS_SOLD[tier] ?? TIER_DAYS_SOLD.normal;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}
