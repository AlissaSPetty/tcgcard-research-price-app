# tcgcard-research-price-app

**Market workflow:** **`market-sold-comps-ingest`** runs three eBay **Finding API** searches (`findCompletedItems`, sold US) per Normal / Holo / Reverse Holo into **`market_sold_comps`**. **Buy It Now (Browse)** comps are written to **`market_rss_cards`** only when a user opens a card in **`listing-admin`** (Edge **`market-comps-card-fetch`**, with cooldown + optional refresh). Optional batch backfill: **`market-comps-ingest`** can still process the full catalog when invoked manually (GitHub **`workflow_dispatch`** or CLI). The catalog grid shows **sold + TCGplayer**; **live BIN** appears on the card detail page.

## Layout

| Path | Role |
|------|------|
| **`supabase/migrations/`** | `market_rss_cards`, `pokemon_card_images`, `lp_*` schema |
| **`supabase/functions/market-comps-ingest/`** | Browse API batch → `market_rss_cards` (manual / operators) |
| **`supabase/functions/market-comps-card-fetch/`** | Browse API one card → `market_rss_cards` (listing-admin detail; cooldown) |
| **`supabase/functions/market-sold-comps-ingest/`** | Finding API sold comps → `market_sold_comps` (App ID only) |
| **`supabase/functions/pokemon-card-images-ingest/`** | tcgcsv.com (TCGPlayer) → `pokemon_card_images` |
| **`supabase/functions/tcgcsv-catalog-scheduled-ingest/`** | Cron helper — loops **`pokemon-card-images-ingest`** until all tcgcsv groups finish |
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
   supabase functions deploy market-comps-card-fetch
   supabase functions deploy market-sold-comps-ingest
   supabase functions deploy pokemon-card-images-ingest
   supabase functions deploy tcgcsv-catalog-scheduled-ingest
   ```
4. Set secrets — see [`supabase/edge-secrets.env.example`](supabase/edge-secrets.env.example). Required for active comps: **`EBAY_APP_ID`**, **`EBAY_CERT_ID`** (Browse client credentials). Sold ingest uses **`EBAY_APP_ID`** only (Finding API). **`LISTING_CRON_SECRET`** for cron. Catalog ingest uses **tcgcsv.com** (no API key). Optional: **`TCGCSV_CATEGORY_BASE`**, **`POKEMON_CARD_IMAGES_GROUPS_PER_RUN`**, **`MARKET_COMPS_*`**, **`MARKET_SOLD_COMPS_*`** batching envs.
5. Copy [`.env.example`](.env.example) → **`listing-admin/.env`** with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
6. `cd listing-admin && npm install && npm run dev` — sign in, open Pokémon cards + comps

## Tests

```bash
npm install
npm test
```

## Market comps (Browse / active BIN)

**Scheduled cron is disabled** for `market-comps-ingest`; live BIN data is populated by **`market-comps-card-fetch`** when users open a card in listing-admin (see **`MARKET_COMPS_CARD_COOLDOWN_MINUTES`** in [`supabase/edge-secrets.env.example`](supabase/edge-secrets.env.example)).

To **backfill or re-run** the full-catalog Browse ingest manually, use GitHub Actions **`workflow_dispatch`** on [`.github/workflows/market-comps-cron.yml`](.github/workflows/market-comps-cron.yml) or the listing-pipeline CLI (below). Auth:

- **`Authorization: Bearer <session JWT>`**, or  
- **`x-cron-secret: <LISTING_CRON_SECRET>`** (or `MARKET_COMPS_CRON_SECRET` if set)

**GitHub Actions:** [`.github/workflows/market-comps-cron.yml`](.github/workflows/market-comps-cron.yml) (manual only)

| Secret | Value |
|--------|--------|
| `SUPABASE_MARKET_COMPS_INGEST_URL` | `https://<project-ref>.supabase.co/functions/v1/market-comps-ingest` |
| `LISTING_CRON_SECRET` | Same as Edge secret `LISTING_CRON_SECRET` |

Optional env on the function: **`MARKET_COMPS_OFFSET`**, **`MARKET_COMPS_BATCH_SIZE`**, **`MARKET_COMPS_BROWSE_LIMIT`**, **`MARKET_COMPS_MAX_LISTINGS_PER_SEARCH`**, **`MARKET_COMPS_SEARCH_DELAY_MS`**, **`MARKET_COMPS_BROWSE_MAX_RETRIES`** (eBay rate-limit retries per search; default **4**). If you see **WORKER_LIMIT** or **504** from Edge, lower **`MARKET_COMPS_MAX_LISTINGS_PER_SEARCH`** and **`MARKET_COMPS_BROWSE_MAX_RETRIES`**, keep **`MARKET_COMPS_BATCH_SIZE=1`**, and redeploy.

**Manual single run:** `cd listing-pipeline && npm run market-comps-ingest` or **`npm run market-sold-comps-ingest`** (same **`SUPABASE_URL`** + cron or operator auth as [`listing-pipeline/README.md`](listing-pipeline/README.md)).

## Cron (sold comps)

Schedule **`POST`** `/functions/v1/market-sold-comps-ingest` (default workflow **02:00 UTC**). Same auth as market comps. **GitHub Actions:** [`.github/workflows/market-sold-comps-cron.yml`](.github/workflows/market-sold-comps-cron.yml)

| Secret | Value |
|--------|--------|
| `SUPABASE_MARKET_SOLD_COMPS_INGEST_URL` | `https://<project-ref>.supabase.co/functions/v1/market-sold-comps-ingest` |
| `LISTING_CRON_SECRET` | Same as Edge secret |

**Finding API:** eBay may restrict or deprecate `findCompletedItems` depending on your developer program. If responses are empty or non-success ACKs, check the [eBay Developers Program](https://developer.ebay.com/) docs and your app’s API access before relying on sold comps in production.

## Pokémon catalog sync

Populate / update **`pokemon_card_images`** by calling the **`pokemon-card-images-ingest`** Edge Function (**[tcgcsv.com](https://tcgcsv.com)** JSON, TCGPlayer **`productId`** → upsert on **`tcgplayer_product_id`**). Same auth as other functions: **`Authorization: Bearer <session JWT>`** (signed-in **listing-admin** — use **Refresh catalog from tcgcsv (TCGPlayer)**) or **`x-cron-secret: <LISTING_CRON_SECRET>`** (CLI / automation).

Catalog generation is controlled through `listing_catalog_meta`:

- `tcgcsv_ingest_running=true` while scheduled or emergency ingest batches are in flight.
- `tcgcsv_catalog_generation` bumps only after successful scheduled completion (or explicit full rerun).
- Emergency batch repair clears `tcgcsv_ingest_running` without bumping generation/hot movers.
- Dashboard listens to Realtime on `listing_catalog_meta` for ingest completion.

CLI (loops group batches like the dashboard button): `cd listing-pipeline && npm run refresh-pokemon-cards` — requires **`SUPABASE_URL`** and **`LISTING_CRON_SECRET`** or operator **`LISTING_EMAIL`** / **`LISTING_PASSWORD`** / **`SUPABASE_ANON_KEY`** in `.env`.

**Chunking:** Each POST walks **`POKEMON_CARD_IMAGES_GROUPS_PER_RUN`** tcgcsv groups (default **1**, so one set per request). If a group fails (fetch, upsert, snapshots), that slice still returns **HTTP 200** with **`partial: true`** and **`errors`**, and **`nextStartGroupIndex`** advances so orchestrators and the dashboard **keep going**. Raise **`POKEMON_CARD_IMAGES_GROUPS_PER_RUN`** (for example **4**) when you want fewer round-trips per full refresh.

### Daily schedule (after tcgcsv publish)

tcgcsv refreshes catalog data around **20:00 UTC**; waiting **~20 minutes** avoids hitting their API before new prices land.

**Option A — GitHub Actions (recommended for long full-catalog runs):** [`.github/workflows/tcgcsv-catalog-cron.yml`](.github/workflows/tcgcsv-catalog-cron.yml) runs at **20:20 UTC** and POSTs **`pokemon-card-images-ingest`** in a loop until **`done`**. Repository secrets: **`SUPABASE_POKEMON_CARD_IMAGES_INGEST_URL`** (`https://<project-ref>.supabase.co/functions/v1/pokemon-card-images-ingest`), **`LISTING_CRON_SECRET`**.

**Option B — Edge orchestrator + pg_cron:** Deploy **`tcgcsv-catalog-scheduled-ingest`**, then schedule **`POST`** `/functions/v1/tcgcsv-catalog-scheduled-ingest` with **`x-cron-secret`** (same secret). That function chains **`pokemon-card-images-ingest`** until finished. See [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions) (`pg_cron` + **`pg_net`** + Vault). Example schedule: **`20 20 * * *`** (20:20 UTC daily). If a single invocation exceeds your project’s Edge time limit, use Option A or raise limits — full Pokémon catalog ingestion can run for several minutes across many batches.

### Ops recovery: `ingest_running` stuck true

If an ingest run aborts unexpectedly and `listing_catalog_status()` keeps returning `ingest_running=true`, clear it manually:

```sql
select public.set_listing_catalog_ingest_running(false);
```

Use this only for recovery after confirming no ingest jobs are still running.

## After a full database reset migration

If you apply a migration that **truncates `lp_*` and market tables** (for example switching the catalog to tcgcsv), note:

- **eBay OAuth:** rows in **`lp_ebay_accounts`** are removed. Users must **connect eBay again** in listing-admin.
- **Storage:** `TRUNCATE` does not delete objects in the **`listing-card-images`** bucket. Clear it in the Supabase dashboard or with the Storage API if you want uploaded card photos removed.
