import {
  mapTcgcsvProductToRow,
  pickTcgcsvPriceRowForProduct,
  tcgcsvPriceRowMapFromResults,
  tcgplayerPriceCentsFrom,
  seriesFromGroupName,
  tcgcsvSeriesPrefixFromGroupName,
  tcgplayerImageLarger,
} from "../../supabase/functions/_shared/listing/tcgcsv_product";

describe("mapTcgcsvProductToRow", () => {
  const group = {
    groupId: 24380,
    name: "ME01: Mega Evolution",
    publishedOn: "2025-09-26T00:00:00",
  };

  it("maps a card-style product with extended data", () => {
    const row = mapTcgcsvProductToRow(
      {
        productId: 654340,
        name: "Bulbasaur - 001/132",
        imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/654340_200w.jpg",
        extendedData: [
          { name: "Number", value: "001/132" },
          { name: "Rarity", value: "Common" },
          { name: "Card Type", value: "Grass" },
          { name: "HP", value: "80" },
        ],
        presaleInfo: { isPresale: false, releasedOn: null, note: null },
      },
      group,
    );
    expect(row).not.toBeNull();
    expect(row!.tcgplayer_product_id).toBe(654340);
    expect(row!.name).toBe("Bulbasaur - 001/132");
    expect(row!.card_set).toBe("ME01: Mega Evolution");
    expect(row!.series).toBe("ME");
    expect(row!.card_number).toBe("001/132");
    expect(row!.rarity).toBe("Common");
    expect(row!.set_release_date).toBe("2025-09-26");
    expect(row!.image_url).toContain("400w");
    expect(row!.tcgplayer_prices_by_finish).toBeNull();
  });

  it("returns null without productId", () => {
    expect(mapTcgcsvProductToRow({ name: "X" }, group)).toBeNull();
  });

  it("uses tcgcsv /prices row when /products omits marketPrice", () => {
    const row = mapTcgcsvProductToRow(
      {
        productId: 675821,
        name: "Bayleef",
        imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/675821_200w.jpg",
      },
      group,
      {
        productId: 675821,
        marketPrice: 0.24,
        lowPrice: 0.01,
        subTypeName: "Normal",
      },
    );
    expect(row).not.toBeNull();
    expect(row!.tcgplayer_price_cents).toBe(24);
    expect(row!.tcgplayer_prices_by_finish).toBeNull();
  });
});

describe("tcgplayerPriceCentsFrom", () => {
  it("falls back to directLowPrice", () => {
    expect(
      tcgplayerPriceCentsFrom(
        { productId: 1 },
        { directLowPrice: 0.1, marketPrice: null as unknown as null },
    ),
    ).toBe(10);
  });
});

describe("pickTcgcsvPriceRowForProduct", () => {
  it("prefers Normal over other subtypes", () => {
    const rows = [
      { productId: 1, marketPrice: 0.3, subTypeName: "Reverse Holofoil" },
      { productId: 1, marketPrice: 0.27, subTypeName: "Normal" },
    ] as Record<string, unknown>[];
    expect(
      (pickTcgcsvPriceRowForProduct(rows) as { marketPrice: number })
        .marketPrice,
    ).toBe(0.27);
  });
});

describe("tcgcsvPriceRowMapFromResults", () => {
  it("indexes one chosen row per productId", () => {
    const m = tcgcsvPriceRowMapFromResults([
      { productId: 1, marketPrice: 9, subTypeName: "Normal" },
      { productId: 1, marketPrice: 99, subTypeName: "Holofoil" },
    ]);
    expect(m.get(1)?.marketPrice).toBe(9);
  });
});

describe("seriesFromGroupName", () => {
  it("uses the segment before the colon", () => {
    expect(seriesFromGroupName("SV: Scarlet & Violet")).toBe("SV");
  });
});

describe("tcgcsvSeriesPrefixFromGroupName", () => {
  it("strips trailing digits from the code segment", () => {
    expect(tcgcsvSeriesPrefixFromGroupName("ME03: Perfect Order")).toBe("ME");
    expect(tcgcsvSeriesPrefixFromGroupName("ME: Mega Evolution Promo")).toBe("ME");
  });
  it("keeps letter-only codes", () => {
    expect(tcgcsvSeriesPrefixFromGroupName("SV: Scarlet & Violet")).toBe("SV");
  });
});

describe("tcgplayerImageLarger", () => {
  it("replaces 200w with 400w", () => {
    expect(
      tcgplayerImageLarger(
        "https://tcgplayer-cdn.tcgplayer.com/product/1_200w.jpg",
      ),
    ).toBe("https://tcgplayer-cdn.tcgplayer.com/product/1_400w.jpg");
  });
});
