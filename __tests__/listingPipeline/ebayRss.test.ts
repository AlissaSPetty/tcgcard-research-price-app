import {
  parseEbaySoldRssItems,
  shippingCentsFromSoldText,
} from "../../supabase/functions/_shared/listing/ebay_rss_sold";

describe("shippingCentsFromSoldText", () => {
  it("treats free delivery like free shipping (eBay search copy)", () => {
    expect(shippingCentsFromSoldText("Something Free delivery US")).toBe(0);
    expect(shippingCentsFromSoldText("Free shipping")).toBe(0);
  });
});

describe("parseEbaySoldRssItems", () => {
  it("parses USD word prices (rssbay-style descriptions)", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
<item>
<title><![CDATA[Test Card]]></title>
<description><![CDATA[<span><strong>USD 12.34</strong></span>]]></description>
</item>
</channel></rss>`;
    const rows = parseEbaySoldRssItems(xml, 10);
    expect(rows[0].priceCents).toBe(1234);
  });

  it("parses RSS items with price and shipping", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
<item>
<title><![CDATA[Charizard VMAX PSA 10]]></title>
<link>https://www.ebay.com/itm/111</link>
<pubDate>Wed, 01 Jan 2025 12:00:00 GMT</pubDate>
<description><![CDATA[ <div>US $45.99 + $5.00 shipping ]]></description>
</item>
<item>
<title><![CDATA[Another Card]]></title>
<description><![CDATA[ Sold $12.50 Free shipping ]]></description>
</item>
</channel></rss>`;
    const rows = parseEbaySoldRssItems(xml, 10);
    expect(rows.length).toBe(2);
    expect(rows[0].title).toContain("Charizard");
    expect(rows[0].link).toBe("https://www.ebay.com/itm/111");
    expect(rows[0].pubDate).toContain("2025");
    expect(rows[0].priceCents).toBe(4599);
    expect(rows[0].shippingCents).toBe(500);
    expect(rows[1].priceCents).toBe(1250);
    expect(rows[1].shippingCents).toBe(0);
  });

  it("includes items without a parseable price", () => {
    const xml = `<rss><channel>
<item>
<title><![CDATA[Graded card lot]]></title>
<link>https://www.ebay.com/itm/222</link>
<description><![CDATA[No dollar amount in this snippet]]></description>
</item>
</channel></rss>`;
    const rows = parseEbaySoldRssItems(xml, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("Graded");
    expect(rows[0].priceCents).toBeNull();
    expect(rows[0].link).toContain("ebay.com");
  });

  it("respects maxItems", () => {
    const xml = `<rss><channel>
<item><title><![CDATA[A]]></title><description><![CDATA[$1.00]]></description></item>
<item><title><![CDATA[B]]></title><description><![CDATA[$2.00]]></description></item>
</channel></rss>`;
    expect(parseEbaySoldRssItems(xml, 1)).toHaveLength(1);
  });
});
