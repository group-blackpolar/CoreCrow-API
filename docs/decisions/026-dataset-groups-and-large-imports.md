# Dataset Groups and large XLSX imports

- Status: Accepted for Phase 1 (2026-10-18); later phases proposed
- Scope: CORECROW dataset module + NORTH Queries center

## Why the ~90 MB import failed

The path is one signed `PUT` to MinIO, a ClamAV scan, an archive validation, then a two-pass streaming parse. Every layer had its own 50 MiB-era ceiling, so a 90 MB workbook was stopped at whichever was reached first:

| Layer | Old value | Effect on 90 MB |
| --- | --- | --- |
| nginx `corecrow-dataset-imports` `client_max_body_size` | 52m | 413 on the upload |
| Worker `NORTH_DATA_IMPORT_MAX_BYTES` (hard ceiling in `import-worker-runtime.ts`) | 50 MiB, not configurable above | worker refused to start, or `IMPORT_SIZE_MISMATCH` |
| `NORTH_DATA_IMPORT_MAX_COMPRESSED_BYTES` | 50 MiB default | `IMPORT_ARCHIVE_LIMIT_EXCEEDED` |
| Expanded size / entry bytes | 768 / 512 MiB | a 90 MB workbook expands ~11x (ADR 025: 26 MB -> 296 MB) |
| Rows / cells | 500k / 20M | ~90 MB is roughly 650k rows |
| NORTH `ImportWizard` | hard-coded 50 MiB | rejected in the browser first |

Nothing was a memory or timeout problem: ADR 025 already streams (child ~170 MiB RSS for 192k rows).

## Phase 1 (implemented)

- Limits are now one policy: API default 100 MiB, hard ceiling 256 MiB (`IMPORT_MAX_BYTES_CEILING`, equal to ClamAV `StreamMaxLength`). Compressed 100/256 MiB, entry 1 GiB, expanded 1.5 GiB, rows 1,000,000 (DB batch check is 1,048,576), cells 40M. Env overrides still clamp to ceilings; there is no unlimited setting.
- `NorthDatasetGroup` + nullable `NorthDataset.groupId/periodStart/periodEnd/periodLabel` (migration `20261018120000_north_dataset_groups`, additive; existing datasets keep `groupId = NULL` and are unchanged). Composite FK `(groupId, organizationId)` makes cross-tenant assignment impossible at the database level.
- Endpoints (OpenAPI regenerated): `GET/POST /organizations/:id/dataset-groups`, `GET/PATCH/DELETE .../dataset-groups/:groupId`, `GET .../:groupId/dependencies`, `GET .../:groupId/audit`, `PUT /organizations/:id/datasets/:datasetId/group`.
- Authorization reuses the existing capabilities: read = `north.data.read`; create/edit/archive/assign/delete/audit = `north.data.manage`. A group summary counts only datasets the caller may see (dataset ACL + archive rules), so a group never leaks hidden datasets.
- Overlapping periods inside a group are refused with `PERIOD_OVERLAP` unless `allowOverlap` is sent (explicit acknowledgement in the UI).
- Deleting a group requires archiving first, shows its exact scope (`/dependencies`) and only detaches member datasets; datasets, data and files are never erased. Dataset erase keeps its existing archive-first rule.
- Audit: `NORTH_DATASET_GROUP_{CREATED,UPDATED,ARCHIVED,RESTORED,DELETED,ASSIGNED,REMOVED}` through the existing `AuditLog` (append-only through `auditRepository.append`, no secrets in metadata).
- NORTH: a "Groups" tab in Queries (list, create, detail sheet with datasets/period assignment, audit history, archive, delete with scope).

## Later phases (not implemented; each is independently shippable)

2. **Incremental import**: add `APPEND` (and later `MERGE`) activation next to `REPLACE_DATASET` (`NorthDatasetRevisionMode`). Per-period datasets already allow "add May 2026" without touching older periods; the group is the logical whole. Needs duplicate/period checks on the analysis step and a checksum duplicate lookup (`declaredChecksum` is already stored per job).
3. **Chunked/resumable upload**: S3 multipart against MinIO with persistent part state; only needed above the 256 MiB ceiling, because the single signed PUT is already streamed server-side. The browser still hashes the file in memory (`crypto.subtle` has no streaming digest); ~2x file size peak.
4. **Unified group queries**: a query endpoint over the member datasets' active revisions with a date filter. The query engine scans jsonb (ADR 025: ~2 s at 200k rows), so typed/partitioned storage must come first for multi-million-row groups. Parquet is not justified yet.
5. **Pipelines/scripts**: registry, versions and parameters can be built, but execution must stay disabled until an isolated runner exists (no network, no env, CPU/memory/time/disk limits, no DB access). The current parser child (Node permission model) is the pattern to extend.

## Deploy and recovery

1. Back up the database (`pg_dump -Fc`), then `prisma migrate deploy` (additive).
2. Set `NORTH_DATA_IMPORT_MAX_BYTES` on both the API and `corecrow-dataset-worker` (e.g. 157286400) and install the new nginx snippet (`client_max_body_size 260m` for `/corecrow-dataset-imports/`), then reload nginx. Deploy CORECROW before NORTH.
3. Rollback: the migration header lists the `DROP` statements; groups hold no data, so dropping them cannot lose datasets. Reverting the limits is an env change.
