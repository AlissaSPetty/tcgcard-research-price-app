import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
const supabase = createClient(url, anon);

type PokemonCardImageRow = {
  id: string;
  external_id: string;
  name: string;
  image_url: string | null;
  holo_image_url: string | null;
  reverse_holo_image_url: string | null;
  card_set: string | null;
  details: string | null;
  rarity: string | null;
  evolves_from: string | null;
  artist: string | null;
  card_number: string | null;
  created_at: string;
  updated_at: string;
};

type MarketCompRow = {
  id: string;
  pokemon_card_image_id: string | null;
  card_type: string;
  price_cents_history: unknown;
  shipping_history: unknown;
  shipping_average_free: boolean;
  shipping_average_cents: number | null;
  average_price_cents: number | null;
  listed_date: string | null;
};

type PokemonCardFilters = {
  name: string;
  card_set: string;
  card_number: string;
  rarity: string;
  artist: string;
  evolves_from: string;
  details: string;
  external_id: string;
};

const DEFAULT_POKEMON_CARD_FILTERS: PokemonCardFilters = {
  name: "",
  card_set: "",
  card_number: "",
  rarity: "",
  artist: "",
  evolves_from: "",
  details: "",
  external_id: "",
};

const POKEMON_CARDS_PAGE_SIZE = 30;
const COMP_FINISH_ORDER = ["Normal", "Holo", "Reverse Holo"] as const;

function ilikeContainsPattern(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const safe = t.replace(/[%_\\]/g, "");
  if (!safe) return null;
  return `%${safe}%`;
}

function fmtCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function priceHistoryNums(h: unknown): number[] {
  if (!Array.isArray(h)) return [];
  return h.filter((x): x is number => typeof x === "number");
}

/** Last up to 5 distinct prices (recency order preserved). */
function uniqueRecentPrices(history: unknown, max = 5): number[] {
  const nums = priceHistoryNums(history);
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = nums.length - 1; i >= 0 && out.length < max; i--) {
    const p = nums[i];
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.reverse();
}

function formatShippingCell(x: unknown): string {
  if (x === "free" || x === null) return "$0.00";
  if (x === "unknown") return "unknown";
  if (typeof x === "number") return fmtCents(x);
  return String(x);
}

function lastFiveShippingDisplay(history: unknown): string {
  if (!Array.isArray(history)) return "—";
  const parts = history.slice(-5).map(formatShippingCell);
  return parts.join(", ") || "—";
}

function compKey(pokemonId: string, cardType: string): string {
  return `${pokemonId}::${cardType}`;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");
  const [ebayConnected, setEbayConnected] = useState(false);
  const [oauthTabPending, setOauthTabPending] = useState(false);
  const [pokemonCards, setPokemonCards] = useState<PokemonCardImageRow[]>([]);
  const [pokemonCardsTotal, setPokemonCardsTotal] = useState(0);
  const [pokemonCardsPage, setPokemonCardsPage] = useState(1);
  const [pokemonCardFilters, setPokemonCardFilters] = useState<PokemonCardFilters>(
    () => ({ ...DEFAULT_POKEMON_CARD_FILTERS }),
  );
  const [pokemonCardsLoading, setPokemonCardsLoading] = useState(false);
  const [compsByKey, setCompsByKey] = useState<Record<string, MarketCompRow>>({});

  const updatePokemonCardFilter = useCallback(
    <K extends keyof PokemonCardFilters>(key: K, value: string) => {
      setPokemonCardFilters((prev) => ({ ...prev, [key]: value }));
      setPokemonCardsPage(1);
    },
    [],
  );

  const loadMarketCompsForIds = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setCompsByKey({});
      return;
    }
    const { data, error: e } = await supabase
      .from("market_rss_cards")
      .select(
        "id, pokemon_card_image_id, card_type, price_cents_history, shipping_history, shipping_average_free, shipping_average_cents, average_price_cents, listed_date",
      )
      .in("pokemon_card_image_id", ids);

    if (e) {
      setError(e.message);
      return;
    }
    const next: Record<string, MarketCompRow> = {};
    for (const row of (data ?? []) as MarketCompRow[]) {
      const pid = row.pokemon_card_image_id;
      if (!pid) continue;
      next[compKey(pid, row.card_type)] = row;
    }
    setCompsByKey(next);
  }, []);

  const loadPokemonCards = useCallback(async () => {
    if (!session) return;
    setPokemonCardsLoading(true);
    try {
      const from = (pokemonCardsPage - 1) * POKEMON_CARDS_PAGE_SIZE;
      const to = from + POKEMON_CARDS_PAGE_SIZE - 1;
      const f = pokemonCardFilters;

      let q = supabase
        .from("pokemon_card_images")
        .select(
          "id, external_id, name, image_url, holo_image_url, reverse_holo_image_url, card_set, details, rarity, evolves_from, artist, card_number, created_at, updated_at",
          { count: "exact" },
        );

      const addIlike = (
        column: keyof Pick<
          PokemonCardImageRow,
          | "name"
          | "card_set"
          | "card_number"
          | "rarity"
          | "artist"
          | "evolves_from"
          | "details"
          | "external_id"
        >,
        value: string,
      ) => {
        const pat = ilikeContainsPattern(value);
        if (pat) q = q.ilike(column, pat);
      };

      addIlike("name", f.name);
      addIlike("card_set", f.card_set);
      addIlike("card_number", f.card_number);
      addIlike("rarity", f.rarity);
      addIlike("artist", f.artist);
      addIlike("evolves_from", f.evolves_from);
      addIlike("details", f.details);
      addIlike("external_id", f.external_id);

      const { data, error: e, count } = await q
        .order("name", { ascending: true })
        .range(from, to);

      if (e) {
        setError(e.message);
        return;
      }
      setError(null);
      setPokemonCardsTotal(count ?? 0);
      const rows = (data ?? []) as PokemonCardImageRow[];
      setPokemonCards(rows);
      await loadMarketCompsForIds(rows.map((r) => r.id));
    } finally {
      setPokemonCardsLoading(false);
    }
  }, [session, pokemonCardsPage, pokemonCardFilters, loadMarketCompsForIds]);

  const loadSafeAccount = useCallback(async () => {
    const { data } = await supabase.from("lp_ebay_accounts_safe").select("*").maybeSingle();
    if (data && typeof data === "object") {
      const row = data as Record<string, unknown>;
      setEbayConnected(!!row.has_refresh_token);
      if (row.has_refresh_token) setOauthTabPending(false);
    } else {
      setEbayConnected(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadSafeAccount();
  }, [session, loadSafeAccount]);

  useEffect(() => {
    if (!session) return;
    void loadPokemonCards();
  }, [session, loadPokemonCards]);

  useEffect(() => {
    if (!session) return;
    const ch = supabase
      .channel("pokemon_card_images_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pokemon_card_images" },
        () => {
          void loadPokemonCards();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [session, loadPokemonCards]);

  useEffect(() => {
    if (!session) return;
    const ch = supabase
      .channel("market_rss_cards_comps")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "market_rss_cards" },
        () => {
          void loadPokemonCards();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [session, loadPokemonCards]);

  const pokemonFiltersActive = useMemo(
    () => Object.values(pokemonCardFilters).some((v) => v.trim() !== ""),
    [pokemonCardFilters],
  );

  const pokemonCardsTotalPages = Math.max(
    1,
    Math.ceil(pokemonCardsTotal / POKEMON_CARDS_PAGE_SIZE),
  );
  const pokemonCardsPageSafe = Math.min(pokemonCardsPage, pokemonCardsTotalPages);

  useEffect(() => {
    setPokemonCardsPage((p) => Math.min(p, pokemonCardsTotalPages));
  }, [pokemonCardsTotalPages]);

  useEffect(() => {
    if (!oauthTabPending) return;
    const id = window.setInterval(() => void loadSafeAccount(), 2000);
    const onFocus = () => void loadSafeAccount();
    window.addEventListener("focus", onFocus);
    const maxWait = window.setTimeout(() => setOauthTabPending(false), 10 * 60_000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(maxWait);
      window.removeEventListener("focus", onFocus);
    };
  }, [oauthTabPending, loadSafeAccount]);

  async function signIn(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function connectEbay() {
    setError(null);
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) {
      setError("Sign in first");
      return;
    }
    const { data, error: fnErr, response } = await supabase.functions.invoke<{
      url?: string;
      error?: string;
    }>("ebay-oauth-start", { method: "POST" });
    if (fnErr) {
      let msg = fnErr.message;
      if (response) {
        const t = await response.text();
        if (t) {
          try {
            const j = JSON.parse(t) as { error?: string; msg?: string };
            msg = j.error ?? j.msg ?? t;
          } catch {
            msg = t;
          }
        }
      }
      setError(msg);
      return;
    }
    if (!data?.url) return;
    const tab = window.open(data.url, "_blank", "noopener,noreferrer");
    if (!tab) {
      setError("Popup blocked — allow popups for this site, or try again.");
      return;
    }
    setOauthTabPending(true);
    void loadSafeAccount();
  }

  async function loadAudit() {
    const { data, error: e } = await supabase
      .from("lp_audit_log")
      .select("action, message, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (e) setError(e.message);
    else setLog(JSON.stringify(data ?? [], null, 2));
  }

  if (!url || !anon) {
    return (
      <p className="error">
        Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this app.
      </p>
    );
  }

  if (!session) {
    return (
      <>
        <h1>Listing pipeline admin</h1>
        <section>
          <h2>Sign in</h2>
          <form onSubmit={signIn}>
            <label>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
            <label>Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
            />
            <button type="submit">Sign in</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </>
    );
  }

  return (
    <>
      <h1>Listing pipeline admin</h1>
      <p>
        Signed in as {session.user.email}{" "}
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>

      <section>
        <h2>eBay connection</h2>
        {ebayConnected ? (
          <p style={{ fontSize: "0.95rem", color: "#166534" }}>eBay account connected.</p>
        ) : (
          <>
            <button type="button" onClick={() => void connectEbay()}>
              Connect eBay account
            </button>
            {oauthTabPending && (
              <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: "0.5rem" }}>
                Finish signing in with eBay in the new tab, then close it. This page updates
                automatically when the connection succeeds.
              </p>
            )}
          </>
        )}
        <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: "0.5rem" }}>
          Market comps use the eBay Browse API with your app credentials (see{" "}
          <code>market-comps-ingest</code> and <code>EBAY_APP_ID</code> / <code>EBAY_CERT_ID</code>).
        </p>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Pokémon cards &amp; eBay comps</h2>
        <p style={{ fontSize: "0.9rem", marginTop: 0, color: "#334155" }}>
          Catalog from <code>pokemon_card_images</code>. Active BIN comps per finish (Normal / Holo /
          Reverse Holo) are stored in <code>market_rss_cards</code> and updated by{" "}
          <code>market-comps-ingest</code> (scheduled via{" "}
          <code>.github/workflows/market-comps-cron.yml</code>).
        </p>
        {pokemonCardsLoading && (
          <p style={{ fontSize: "0.85rem", color: "#64748b" }}>Loading…</p>
        )}
        <h3 style={{ fontSize: "1rem", marginTop: "0.75rem", marginBottom: "0.35rem" }}>Filters</h3>
        <p style={{ fontSize: "0.82rem", color: "#64748b", marginTop: 0, marginBottom: "0.5rem" }}>
          Optional filters combine with <strong>AND</strong> (case-insensitive substring).
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "0.5rem",
            alignItems: "end",
            marginBottom: "1rem",
          }}
        >
          <div>
            <label>Name</label>
            <input
              value={pokemonCardFilters.name}
              onChange={(e) => updatePokemonCardFilter("name", e.target.value)}
              placeholder="Card name"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Set</label>
            <input
              value={pokemonCardFilters.card_set}
              onChange={(e) => updatePokemonCardFilter("card_set", e.target.value)}
              placeholder="Set name"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Card #</label>
            <input
              value={pokemonCardFilters.card_number}
              onChange={(e) => updatePokemonCardFilter("card_number", e.target.value)}
              placeholder="e.g. 4, 102/88"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Rarity</label>
            <input
              value={pokemonCardFilters.rarity}
              onChange={(e) => updatePokemonCardFilter("rarity", e.target.value)}
              placeholder="e.g. Rare Holo"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Artist</label>
            <input
              value={pokemonCardFilters.artist}
              onChange={(e) => updatePokemonCardFilter("artist", e.target.value)}
              placeholder="Artist name"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Evolves from</label>
            <input
              value={pokemonCardFilters.evolves_from}
              onChange={(e) => updatePokemonCardFilter("evolves_from", e.target.value)}
              placeholder="Pokémon name"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Details</label>
            <input
              value={pokemonCardFilters.details}
              onChange={(e) => updatePokemonCardFilter("details", e.target.value)}
              placeholder="Text in details / rules"
              autoComplete="off"
            />
          </div>
          <div>
            <label>External id</label>
            <input
              value={pokemonCardFilters.external_id}
              onChange={(e) => updatePokemonCardFilter("external_id", e.target.value)}
              placeholder="API card id"
              autoComplete="off"
            />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              type="button"
              className="secondary"
              disabled={!pokemonFiltersActive}
              onClick={() => {
                setPokemonCardFilters({ ...DEFAULT_POKEMON_CARD_FILTERS });
                setPokemonCardsPage(1);
              }}
            >
              Clear filters
            </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "1.25rem",
          }}
        >
          {pokemonCards.map((c) => (
            <article
              key={c.id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "0.75rem",
                background: "#fafafa",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                minHeight: "100%",
              }}
            >
              {c.image_url ? (
                <img
                  src={c.image_url}
                  alt={c.name}
                  loading="lazy"
                  style={{
                    width: "100%",
                    maxWidth: "220px",
                    margin: "0 auto",
                    aspectRatio: "63 / 88",
                    objectFit: "contain",
                    background: "#fff",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                  }}
                />
              ) : (
                <div
                  style={{
                    aspectRatio: "63 / 88",
                    background: "#f1f5f9",
                    borderRadius: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.8rem",
                    color: "#64748b",
                  }}
                >
                  No image
                </div>
              )}
              <h3 style={{ fontSize: "1rem", margin: 0, lineHeight: 1.35 }}>{c.name}</h3>
              <ul
                style={{
                  margin: 0,
                  padding: "0 0 0 1rem",
                  fontSize: "0.82rem",
                  color: "#334155",
                  lineHeight: 1.45,
                }}
              >
                <li>
                  <strong>Set:</strong> {c.card_set ?? "—"}
                </li>
                <li>
                  <strong>#</strong> {c.card_number ?? "—"}
                </li>
                <li>
                  <strong>Rarity:</strong> {c.rarity ?? "—"}
                </li>
              </ul>
              <div style={{ overflowX: "auto", marginTop: "0.25rem" }}>
                <table
                  style={{
                    width: "100%",
                    fontSize: "0.72rem",
                    borderCollapse: "collapse",
                    background: "#fff",
                    borderRadius: "6px",
                    overflow: "hidden",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Finish</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Last 5 prices</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Avg</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Ship (5)</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Ship avg</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Listed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMP_FINISH_ORDER.map((finish) => {
                      const row = compsByKey[compKey(c.id, finish)];
                      const prices = row
                        ? uniqueRecentPrices(row.price_cents_history, 5)
                        : [];
                      const priceStr = prices.length
                        ? prices.map((p) => (p / 100).toFixed(2)).join(", ")
                        : "—";
                      const shipAvg = row
                        ? row.shipping_average_free
                          ? "$0.00"
                          : row.shipping_average_cents != null
                            ? fmtCents(row.shipping_average_cents)
                            : "unknown"
                        : "—";
                      return (
                        <tr key={finish} style={{ borderTop: "1px solid #e2e8f0" }}>
                          <td style={{ padding: "0.35rem", fontWeight: 600 }}>{finish}</td>
                          <td style={{ padding: "0.35rem", fontVariantNumeric: "tabular-nums" }}>
                            {priceStr}
                          </td>
                          <td style={{ padding: "0.35rem", fontVariantNumeric: "tabular-nums" }}>
                            {row ? fmtCents(row.average_price_cents) : "—"}
                          </td>
                          <td style={{ padding: "0.35rem", fontSize: "0.68rem" }}>
                            {row ? lastFiveShippingDisplay(row.shipping_history) : "—"}
                          </td>
                          <td style={{ padding: "0.35rem" }}>{shipAvg}</td>
                          <td style={{ padding: "0.35rem", whiteSpace: "nowrap" }}>
                            {row?.listed_date ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
        {pokemonCardsTotal > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.75rem",
              marginTop: "1rem",
              fontSize: "0.9rem",
              color: "#334155",
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {(pokemonCardsPageSafe - 1) * POKEMON_CARDS_PAGE_SIZE + 1}–
              {Math.min(
                pokemonCardsPageSafe * POKEMON_CARDS_PAGE_SIZE,
                pokemonCardsTotal,
              )}{" "}
              of {pokemonCardsTotal}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={pokemonCardsPageSafe <= 1 || pokemonCardsLoading}
              onClick={() => setPokemonCardsPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              Page {pokemonCardsPageSafe} of {pokemonCardsTotalPages}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={
                pokemonCardsPageSafe >= pokemonCardsTotalPages || pokemonCardsLoading
              }
              onClick={() =>
                setPokemonCardsPage((p) => Math.min(pokemonCardsTotalPages, p + 1))
              }
            >
              Next
            </button>
          </div>
        )}
        {pokemonCardsTotal === 0 && !pokemonCardsLoading && (
          <p style={{ color: "#64748b", fontSize: "0.9rem" }}>
            {pokemonFiltersActive
              ? "No cards match the current filters."
              : "No catalog cards yet. Run pokemon-card-images-ingest after migrations."}
          </p>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Audit log</h2>
        <button type="button" className="secondary" onClick={() => void loadAudit()}>
          Load last 30 events
        </button>
        {log && <pre className="log">{log}</pre>}
      </section>

      {error && <p className="error">{error}</p>}
    </>
  );
}
