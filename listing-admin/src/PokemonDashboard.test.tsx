import type { ReactElement } from "react";
import type { Session } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PokemonDashboard from "./PokemonDashboard";

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "t", user: { id: "u1" } } },
      }),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(() =>
        Promise.resolve("subscribed"),
      ),
    })),
    removeChannel: vi.fn(),
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
  supabaseUrl: "http://localhost",
  supabaseAnonKey: "anon",
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
    }),
  );

  mockRpc.mockImplementation((name: string) => {
    if (name === "listing_catalog_status") {
      return Promise.resolve({
        data: [{ generation: 1, ingest_running: false }],
        error: null,
      });
    }
    if (name === "list_distinct_pokemon_series") {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === "dashboard_hot_movers") {
      return {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
    }
    if (table === "market_sold_comps") {
      return {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
    }
    if (table === "pokemon_card_images_with_market_activity") {
      const chain = {
        select: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
      };
      return chain;
    }
    return {
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
  });
});

function harness(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("PokemonDashboard", () => {
  it("does not keep an indefinite Loading catalog banner after grid resolves", async () => {
    const session = {
      user: { id: "u1", email: "a@b.com" },
    } as Session;

    render(
      harness(
        <PokemonDashboard
          session={session}
          theme="light"
          setTheme={() => {}}
          onSignOut={() => {}}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading catalog…/)).not.toBeInTheDocument();
    });
  });
});
