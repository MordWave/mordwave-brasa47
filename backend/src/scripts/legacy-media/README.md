# Legacy media migration (Supabase Storage → Railway Bucket)

Copies images that still live only in Supabase Storage (`image_url` /
`logo_url` with a NULL storage key) to the `mordwave-media` bucket and records
the new `image_storage_key` / `logo_storage_key`. Legacy URLs, Supabase objects
and bucket objects are **never** deleted or modified.

## Commands

Both run from `backend/` and need the Railway Postgres **public** URL (TCP
Proxy) plus the backend service variables. Use `railway run` so every secret is
injected into the process only — nothing is written to disk or printed:

```bash
# 1. Inventory + dry-run (read-only). Writes plan.json locally, nothing else.
railway run -s mordwave-postgres -e production -- \
  railway run -s mordwave-brasa47 -e production -- \
  sh -c 'MIGRATE_DB_URL="$DATABASE_PUBLIC_URL" npm run media:legacy -- plan'

# 2. Apply exactly the plan you reviewed (the hash is printed by step 1).
#    Canary first: --only product:<uuid>  or  --limit 1
railway run -s mordwave-postgres -e production -- \
  railway run -s mordwave-brasa47 -e production -- \
  sh -c 'MIGRATE_DB_URL="$DATABASE_PUBLIC_URL" npm run media:legacy -- apply --confirm <planHash> --limit 1'
```

Files go to `~/brasa47-migration/media-legacy/` (`--out` to change): `plan.json`
and `manifest.json` (mode 600; ids, keys, hashes, sizes, states — no secrets, no URLs).

## Guards (abort before any write)

- DB host must be `*.rlwy.net`, never Supabase; `current_database()` must be `railway`;
  the PR 1 columns must exist.
- A legacy URL counts only if it is `https://<SUPABASE_URL host>/storage/v1/object/public/<bucket>/…`
  and its path is the one the old upload code used for **that** row.
- `apply` needs `--confirm <planHash>` matching `plan.json`.

## Per row

download → SHA-256/size must match the plan → copy the **same bytes** (no
re-encoding) with a new key from `media-key.util` → HeadObject (size, type) →
read back through a presigned GET (SHA-256) → `GET /media/<key>` must be a 302
whose target serves the same bytes as `image/webp`, and `HEAD` a 200 → only
then `UPDATE … SET <key column> = $1 WHERE id = $2 AND <key column> IS NULL AND
<legacy url column> = <inventoried url>`.

Any failure leaves that row on Supabase and the run continues with the others.
Re-running is safe: finished rows are skipped, an identical object already at
the destination is reused, a different one is never overwritten.

## Rollback

Per row: `UPDATE products SET image_storage_key = NULL WHERE id = '<id>'` (or
`businesses` / `logo_storage_key`). The legacy URL is still there, so the row is
served from Supabase again. Objects copied to the bucket are harmless orphans
until the final cleanup.
