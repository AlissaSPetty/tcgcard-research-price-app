import { hybridPriceCents } from "../../supabase/functions/_shared/listing/pricing";

describe("hybridPriceCents", () => {
  const cfg = { ebaySampleMin: 3, tcgEnabled: true };

  it("prefers eBay when sample sufficient", async () => {
    const r = await hybridPriceCents(
      "test card",
      cfg,
      async () => ({
        dailyMedianCents: 400,
        weeklyMedianCents: 450,
        sampleSize: 5,
      }),
      async () => ({ medianCents: 300, sampleSize: 2 }),
    );
    expect(r.source).toBe("blended");
    expect(r.cents).toBe(450);
  });

  it("falls back to TCG when eBay thin", async () => {
    const r = await hybridPriceCents(
      "test",
      cfg,
      async () => ({ dailyMedianCents: 200, weeklyMedianCents: 200, sampleSize: 1 }),
      async () => ({ medianCents: 275, sampleSize: 4 }),
    );
    expect(r.source).toBe("tcg");
    expect(r.cents).toBe(275);
  });

  it("returns null when no signal", async () => {
    const r = await hybridPriceCents(
      "test",
      cfg,
      async () => ({ dailyMedianCents: null, weeklyMedianCents: null, sampleSize: 0 }),
      async () => null,
    );
    expect(r.cents).toBeNull();
  });
});
