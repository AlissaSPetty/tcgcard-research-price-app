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

Photo naming: `basename-front.jpg` paired with `basename-back.jpg`.

## Edge Function secrets (Supabase)

Set at minimum for OAuth/listings: `EBAY_APP_ID`, `EBAY_CERT_ID` (or `EBAY_CLIENT_SECRET`), `EBAY_OAUTH_REDIRECT_URL` (must match eBay developer redirect), `LISTING_CRON_SECRET`, and the default Supabase keys for each function. RSS market secrets are documented in **`supabase/edge-secrets.env.example`**.
