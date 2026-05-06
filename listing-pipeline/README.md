# Listing pipeline (CLI)

Optional Node helpers for **folder ingest** (photos → Storage + `lp_cards` / batches) and calling the **`listing-batch-bundles`** Edge Function. The primary **market RSS** workflow does not require this folder; see the [root README](../README.md).

## Environment

- `SUPABASE_URL` — project URL (e.g. `https://xxx.supabase.co`)
- `SUPABASE_ANON_KEY` — anon key (CLI signs in as operator)
- `LISTING_EMAIL` / `LISTING_PASSWORD` — Supabase Auth user that owns rows in `lp_*` tables

## Usage

```bash
cd listing-pipeline
npm install
npx tsx cli/ingest.ts --dir /path/to/card-photos --batch "optional name"
npx tsx cli/call-edge.ts <batch_uuid>
```

`call-edge.ts` invokes **`listing-batch-bundles`** with the given batch id.

**Market comps (eBay Browse → `market_rss_cards`):** optional **operator backfill** — the CLI chains **`market-comps-ingest`** until `completed`. Day-to-day **Buy It Now** rows are updated from **listing-admin** via **`market-comps-card-fetch`** (per card, with cooldown), not from a daily cron. For a full pass, the Edge function uses **stale-first** ordering (coldest comps first via keyset cursor). Legacy **id** order + offset: `MARKET_COMPS_ORDER=id npm run market-comps-ingest -- --offset 500`. See Edge secrets `MARKET_COMPS_BATCH_SIZE`, `MARKET_COMPS_ORDER`, etc. Start partway only in **id** mode:

```bash
npm run market-comps-ingest
npm run market-comps-ingest -- --offset 500
```

Same `.env` as above; add **`LISTING_CRON_SECRET`** (or operator email/password + **`SUPABASE_ANON_KEY`**).

**Sold comps (eBay Finding → `market_sold_comps`):** chains **`market-sold-comps-ingest`** until `completed`. Uses **`EBAY_APP_ID`** only (no client secret for OAuth). Stale-first keyset is the default; legacy id order: `MARKET_SOLD_COMPS_ORDER=id npm run market-sold-comps-ingest -- --offset 500`. Optional Edge envs: `MARKET_SOLD_COMPS_BATCH_SIZE`, `MARKET_SOLD_COMPS_MAX_SEARCHES`, `MARKET_SOLD_COMPS_FINDING_LIMIT`, `MARKET_SOLD_COMPS_SEARCH_DELAY_MS`.

```bash
npm run market-sold-comps-ingest
```

Photo naming: `basename-front.jpg` paired with `basename-back.jpg`.

**HTTP 504 / `WORKER_LIMIT` / “Non-JSON response”:** each invocation must stay within Supabase Edge **CPU/time** limits. Use **`MARKET_COMPS_BATCH_SIZE=1`**, lower **`MARKET_COMPS_MAX_LISTINGS_PER_SEARCH`** (e.g. **3**), lower **`MARKET_COMPS_BROWSE_MAX_RETRIES`** (e.g. **3**), and avoid huge **`MARKET_COMPS_SEARCH_DELAY_MS`** × many eBay retries in one invocation. The ingest CLI **retries** transient 502/504 and JSON **`code: "WORKER_LIMIT"`** responses.

## Edge Function secrets (Supabase)

Set at minimum for OAuth/listings: `EBAY_APP_ID`, `EBAY_CERT_ID` (or `EBAY_CLIENT_SECRET`), `EBAY_OAUTH_REDIRECT_URL` (must match eBay developer redirect), `LISTING_CRON_SECRET`, and the default Supabase keys for each function. RSS market secrets are documented in **`supabase/edge-secrets.env.example`**.
