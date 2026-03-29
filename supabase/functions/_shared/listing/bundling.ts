/**
 * Bundle cards with unit value < $1 so each bundle sums to >= minBundleCents ($4 = 400).
 * Uses largest-first greedy bin packing (fewer bundles; good enough for small batches).
 */

export const MIN_SALE_CENTS = 400;
export const LOW_VALUE_THRESHOLD_CENTS = 100;

export interface CardForBundle {
  id: string;
  unitPriceCents: number;
}

export interface BundleGroup {
  cardIds: string[];
  totalCents: number;
  /** Listed price: max(total, MIN_SALE_CENTS), rounded for BIN */
  listPriceCents: number;
}

function listPriceFromTotal(total: number): number {
  return Math.max(MIN_SALE_CENTS, Math.ceil(total));
}

/**
 * Cards with unit >= MIN_SALE_CENTS become singleton bundles (one card each).
 * Cards with unit in [LOW_VALUE_THRESHOLD, MIN_SALE_CENTS) need grouping with others until sum >= MIN_SALE_CENTS.
 * Cards with unit < LOW_VALUE_THRESHOLD are "bulk" and merged into bins Greedy-first by descending value.
 */
export function partitionForListing(cards: CardForBundle[]): BundleGroup[] {
  const sorted = [...cards].sort((a, b) => b.unitPriceCents - a.unitPriceCents);
  const singles: CardForBundle[] = [];
  const mid: CardForBundle[] = [];
  const low: CardForBundle[] = [];

  for (const c of sorted) {
    if (c.unitPriceCents >= MIN_SALE_CENTS) singles.push(c);
    else if (c.unitPriceCents >= LOW_VALUE_THRESHOLD_CENTS) mid.push(c);
    else low.push(c);
  }

  const out: BundleGroup[] = [];

  for (const c of singles) {
    out.push({
      cardIds: [c.id],
      totalCents: c.unitPriceCents,
      listPriceCents: listPriceFromTotal(c.unitPriceCents),
    });
  }

  // Merge mid + low into bins (largest-first greedy)
  const pool = [...mid, ...low].sort((a, b) => b.unitPriceCents - a.unitPriceCents);
  let current: CardForBundle[] = [];
  let sum = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      cardIds: current.map((c) => c.id),
      totalCents: sum,
      listPriceCents: listPriceFromTotal(sum),
    });
    current = [];
    sum = 0;
  };

  for (const c of pool) {
    if (sum + c.unitPriceCents >= MIN_SALE_CENTS) {
      current.push(c);
      sum += c.unitPriceCents;
      flush();
    } else {
      current.push(c);
      sum += c.unitPriceCents;
    }
  }

  // Remainder: still one bundle if non-empty (may be < MIN_SUM in edge case — caller should hold or pad price)
  if (current.length > 0) {
    out.push({
      cardIds: current.map((c) => c.id),
      totalCents: sum,
      listPriceCents: listPriceFromTotal(sum),
    });
  }

  return out;
}

export function bundleDescriptionLines(cardHints: { id: string; title: string | null }[]): string {
  return cardHints.map((c, i) => `${i + 1}. ${c.title ?? c.id}`).join("\n");
}
