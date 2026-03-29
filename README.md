# tcgcard-research-price-app

**Market workflow:** For each row in **`pokemon_card_images`**, the **`market-comps-ingest`** Edge Function runs three eBay **Browse API** searches (active **Buy It Now**, US) for Normal, Holo, and Reverse Holo, then upserts into **`market_rss_cards`** (one row per catalog card + finish, linked by `pokemon_card_image_id`). **`listing-admin`** shows the catalog with per-finish comp tables (prices, shipping, listed date).

## Layout

| Path | Role |
|------|------|
| **`supabase/migrations/`** | `market_rss_cards`, `pokemon_card_images`, `lp_*` schema |
| **`supabase/functions/market-comps-ingest/`** | Browse API comps → `market_rss_cards` (service role) |
| **`supabase/functions/pokemon-card-images-ingest/`** | Pokémon TCG API v2 → `pokemon_card_images` |
| **`supabase/functions/_shared/listing/market_comps.ts`** | eBay search strings + canonical titles |
| **`supabase/functions/_shared/listing/rss_market.ts`** | Price/shipping rings, averages (shared helpers) |
| **`listing-admin/`** | Vite + React: sign-in, eBay OAuth, Pokémon cards + comps, audit log |
| **`listing-pipeline/`** | Optional CLI — see [`listing-pipeline/README.md`](listing-pipeline/README.md) |

## Quick start

1. Create a Supabase project and link the CLI: `supabase link`
2. Apply migrations: `supabase db push` (or `supabase db reset` locally)
3. Deploy Edge Functions:
   ```bash
   supabase functions deploy market-comps-ingest
   supabase functions deploy pokemon-card-images-ingest
   ```
4. Set secrets — see [`supabase/edge-secrets.env.example`](supabase/edge-secrets.env.example). Required for comps: **`EBAY_APP_ID`**, **`EBAY_CERT_ID`** (client credentials for Browse API), **`LISTING_CRON_SECRET`** for cron. Optional: **`POKEMONTCG_API_KEY`**, **`MARKET_COMPS_*`** batching envs.
5. Copy [`.env.example`](.env.example) → **`listing-admin/.env`** with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
6. `cd listing-admin && npm install && npm run dev` — sign in, open Pokémon cards + comps

## Tests

```bash
npm install
npm test
```

## Cron (market comps)

Schedule **`POST`** `/functions/v1/market-comps-ingest` on your desired cadence (default workflow: every **10 minutes** UTC; adjust batch envs so each run finishes within Edge limits). Auth:

- **`Authorization: Bearer <session JWT>`**, or  
- **`x-cron-secret: <LISTING_CRON_SECRET>`** (or `MARKET_COMPS_CRON_SECRET` if set)

**GitHub Actions:** [`.github/workflows/market-comps-cron.yml`](.github/workflows/market-comps-cron.yml)

| Secret | Value |
|--------|--------|
| `SUPABASE_MARKET_COMPS_INGEST_URL` | `https://<project-ref>.supabase.co/functions/v1/market-comps-ingest` |
| `LISTING_CRON_SECRET` | Same as Edge secret `LISTING_CRON_SECRET` |

Optional env on the function: **`MARKET_COMPS_OFFSET`**, **`MARKET_COMPS_BATCH_SIZE`** (default 15), **`MARKET_COMPS_BROWSE_LIMIT`**, **`MARKET_COMPS_SEARCH_DELAY_MS`**.

## Cron (Pokémon card images)

Schedule **`POST`** `/functions/v1/pokemon-card-images-ingest` **once per day**. See [`.github/workflows/pokemon-card-images-cron.yml`](.github/workflows/pokemon-card-images-cron.yml) — secrets **`SUPABASE_POKEMON_CARD_IMAGES_INGEST_URL`** and **`LISTING_CRON_SECRET`**.
