import { tcgplayerActiveFinishes } from "../../listing-admin/src/tcgFinishScope";

describe("tcgplayerActiveFinishes", () => {
  it("drops Normal when Holo exists and primary cents match", () => {
    const card = {
      tcgplayer_prices_by_finish: {
        Normal: { market_cents: 1000, low_cents: null, high_cents: null, direct_cents: null },
        Holofoil: { market_cents: 1000, low_cents: null, high_cents: null, direct_cents: null },
      },
      tcgplayer_price_cents: null,
    };
    expect(tcgplayerActiveFinishes(card).sort()).toEqual(["Holo"]);
  });

  it("keeps Normal when Holo price differs", () => {
    const card = {
      tcgplayer_prices_by_finish: {
        Normal: { market_cents: 500, low_cents: null, high_cents: null, direct_cents: null },
        Holofoil: { market_cents: 1000, low_cents: null, high_cents: null, direct_cents: null },
      },
      tcgplayer_price_cents: null,
    };
    expect(tcgplayerActiveFinishes(card).sort()).toEqual(["Holo", "Normal"]);
  });

  it("matches legacy Normal cents to Holo market", () => {
    const card = {
      tcgplayer_prices_by_finish: {
        Holofoil: { market_cents: 2500, low_cents: null, high_cents: null, direct_cents: null },
      },
      tcgplayer_price_cents: 2500,
    };
    expect(tcgplayerActiveFinishes(card).sort()).toEqual(["Holo"]);
  });
});
