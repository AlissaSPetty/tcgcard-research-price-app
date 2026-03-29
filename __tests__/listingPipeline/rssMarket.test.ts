import {
  appendPriceRing,
  appendShippingRing,
  appendUniquePriceRing,
  averagePriceCents,
  detectCardType,
  extractCardName,
  extractCardNumber,
  extractQuantityFromTitle,
  isSameMarketListingUrl,
  parseRssbayItem,
  shippingAverageFromHistory,
  shippingFromListingDescription,
} from "../../supabase/functions/_shared/listing/rss_market";
import { parseEbaySoldRssItems } from "../../supabase/functions/_shared/listing/ebay_rss_sold";
import {
  canonicalMarketRssTitle,
  ebayCompSearchQuery,
} from "../../supabase/functions/_shared/listing/market_comps";

describe("rss_market", () => {
  it("detects card type from title keywords", () => {
    expect(detectCardType("Foo Full Art Bar")).toBe("Full Art");
    expect(detectCardType("Foo Reverse Holo Bar")).toBe("Reverse Holo");
    expect(detectCardType("Foo Holo Bar")).toBe("Holo");
    expect(detectCardType("Plain Name")).toBe("Normal");
  });

  it("extracts card number", () => {
    expect(extractCardNumber("Serperior 006/088 POR EN Holo")).toBe("006/088");
    expect(extractCardNumber("no number")).toBeNull();
  });

  it("extracts quantity from xN in title", () => {
    expect(extractQuantityFromTitle("Card x4 NM")).toBe(4);
    expect(extractQuantityFromTitle("Card NM")).toBe(1);
  });

  it("computes ring buffer and averages", () => {
    expect(appendPriceRing([100, 200], 300)).toEqual([100, 200, 300]);
    expect(appendPriceRing([1, 2, 3, 4, 5], 6)).toEqual([2, 3, 4, 5, 6]);
    expect(averagePriceCents([100, 200, 300])).toBe(200);
  });

  it("appendUniquePriceRing keeps last 5 distinct prices", () => {
    expect(appendUniquePriceRing([100, 200, 300], 300)).toEqual([100, 200, 300]);
    expect(appendUniquePriceRing([100, 200, 300], 400)).toEqual([100, 200, 300, 400]);
    expect(appendUniquePriceRing([1, 1, 2, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("shipping average prefers numeric samples; unknown when no amounts", () => {
    const h1 = appendShippingRing(
      ["free", "free", "free", "free", 100],
      "free",
    );
    expect(shippingAverageFromHistory(h1)).toEqual({
      free: false,
      cents: 100,
    });
    const h2: Array<"free" | number> = [100, 200, 300, 400, 500];
    expect(shippingAverageFromHistory(h2)).toEqual({
      free: false,
      cents: 300,
    });
    const h3: Array<"free" | "unknown" | number> = [
      "unknown",
      "unknown",
      "unknown",
    ];
    expect(shippingAverageFromHistory(h3)).toEqual({
      free: false,
      cents: null,
    });
  });

  it("parses rssbay USD and listed-since from description", () => {
    const desc = `
      <div><span><strong>USD 1.99</strong></span></div>
      <div>Listed since: Mar-27 14:49</div>
      <div>Location: US</div>`;
    expect(shippingFromListingDescription(desc)).toBe("unknown");
    const xml = `<?xml version="1.0"?><rss><channel>
<item>
<title><![CDATA[Pokemon TCG Serperior 006/088 POR EN Holo Rare]]></title>
<link>https://www.ebay.com/itm/406801199041</link>
<pubDate>Fri, 27 Mar 2026 14:49:01 +0000</pubDate>
<description><![CDATA[${desc}]]></description>
</item>
</channel></rss>`;
    const rows = parseEbaySoldRssItems(xml, 5);
    expect(rows.length).toBe(1);
    const parsed = parseRssbayItem(rows[0], desc);
    expect(parsed.cardNumber).toBe("006/088");
    expect(parsed.cardType).toBe("Holo");
    expect(parsed.row.priceCents).toBe(199);
    expect(parsed.listedDate).toBe("2026-03-27");
  });

  it("isSameMarketListingUrl matches by eBay item id or exact URL", () => {
    expect(
      isSameMarketListingUrl(
        {
          listing_url: "https://www.ebay.com/itm/111?foo=1",
          ebay_item_id: null,
        },
        "https://www.ebay.com/itm/111?bar=2",
        null,
      ),
    ).toBe(true);
    expect(
      isSameMarketListingUrl(
        { listing_url: "https://www.ebay.com/itm/222", ebay_item_id: "222" },
        "https://www.ebay.com/itm/222",
        "222",
      ),
    ).toBe(true);
    expect(
      isSameMarketListingUrl(
        { listing_url: "https://www.ebay.com/itm/333", ebay_item_id: null },
        "https://www.ebay.com/itm/444",
        null,
      ),
    ).toBe(false);
  });

  it("extractCardName removes Pokemon TCG prefix and trailing number segment", () => {
    const n = extractCardName(
      "Pokemon TCG Serperior 006/088 POR EN Holo Rare Grass Single Card",
    );
    expect(n.toLowerCase()).toContain("serperior");
  });
});

describe("market_comps", () => {
  const row = {
    id: "p1",
    name: "Pikachu",
    card_set: "Base",
    card_number: "58/102",
  };

  it("ebayCompSearchQuery builds three variants", () => {
    expect(ebayCompSearchQuery(row, "Normal")).toBe("Pikachu Base 58/102");
    expect(ebayCompSearchQuery(row, "Holo")).toBe("Pikachu Base 58/102 holo");
    expect(ebayCompSearchQuery(row, "Reverse Holo")).toBe(
      "Pikachu Base 58/102 reverse holo",
    );
  });

  it("canonicalMarketRssTitle matches stored rss_title shape", () => {
    expect(canonicalMarketRssTitle(row, "Normal")).toBe(
      "Pokemon TCG Pikachu Base 58/102",
    );
    expect(canonicalMarketRssTitle(row, "Holo")).toBe(
      "Pokemon TCG Pikachu Base 58/102 Holo",
    );
  });

  it("returns null when fields missing", () => {
    expect(
      ebayCompSearchQuery({ id: "x", name: "", card_set: "S", card_number: "1" }, "Normal"),
    ).toBeNull();
  });
});
