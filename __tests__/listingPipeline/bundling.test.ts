import {
  MIN_SALE_CENTS,
  LOW_VALUE_THRESHOLD_CENTS,
  partitionForListing,
} from "../../supabase/functions/_shared/listing/bundling";

describe("partitionForListing", () => {
  it("keeps high-value singles separate", () => {
    const r = partitionForListing([
      { id: "a", unitPriceCents: 500 },
      { id: "b", unitPriceCents: MIN_SALE_CENTS },
    ]);
    expect(r).toHaveLength(2);
    expect(r.every((g) => g.cardIds.length === 1)).toBe(true);
  });

  it("bundles sub-threshold cards to reach floor", () => {
    const r = partitionForListing([
      { id: "a", unitPriceCents: 30 },
      { id: "b", unitPriceCents: 40 },
      { id: "c", unitPriceCents: 500 },
    ]);
    const multi = r.find((g) => g.cardIds.length > 1);
    expect(multi).toBeDefined();
    expect(multi!.listPriceCents).toBeGreaterThanOrEqual(MIN_SALE_CENTS);
    const single = r.find((g) => g.cardIds.includes("c"));
    expect(single?.cardIds).toEqual(["c"]);
  });

  it("treats 100–399¢ cards as poolable with lows", () => {
    const r = partitionForListing([
      { id: "x", unitPriceCents: LOW_VALUE_THRESHOLD_CENTS },
      { id: "y", unitPriceCents: 50 },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].listPriceCents).toBeGreaterThanOrEqual(MIN_SALE_CENTS);
  });
});
