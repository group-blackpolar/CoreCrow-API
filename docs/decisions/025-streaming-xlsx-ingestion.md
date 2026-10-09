# Streaming XLSX ingestion

- Status: Accepted (2026-10-09)
- Scope: CORECROW dataset import (ADR-006 TD-02), generic for every tenant

## Context

The provisional importer parsed workbooks with SheetJS Community, which cannot stream XLSX: the whole worksheet was held in a JS heap
(384 MiB cap), the result crossed the child's stdout as one JSON document (64 MiB cap), and the database accepted at most 50,000 rows per
batch. A real 26 MB workbook (192,799 rows, 26 columns) expands to a 296 MB worksheet part, so it was rejected by the archive validator
(64 MiB per entry, 256 MiB total) long before parsing.

## Decision

- **Reader**: `yauzl` (ZIP, random access, validated entry sizes) feeding `saxes` (SAX). `xlsx-stream-reader.mjs` yields sparse rows per
  decompressed chunk; nothing is accumulated. It runs inside the Node permission-model child (`--permission`, empty env, read-only access to the
  temp directory and `node_modules`, write access only to its own `spill/` directory).
- **Formulas**: any `<f>` element is rejected (`IMPORT_SOURCE_FORMULA_REJECTED`) even when a cached value exists. Error cells (`t="e"`) fail
  coercion. DTD/entity declarations, external relationships, XML deeper than 64 levels and out-of-order rows are rejected.
- **Types**: numbers, `s`/`inlineStr`/`str`, booleans, ISO `d` cells; date styles are resolved from `cellXfs`/`numFmts` (built-in and custom
  formats) with the 1900 leap-year quirk and the 1904 system. `_xHHHH_` escapes are decoded. Rows with no value are skipped; integer+decimal
  columns profile as `DECIMAL`.
- **Shared strings** stay on the heap up to `NORTH_DATA_IMPORT_SHARED_STRINGS_MEMORY_BYTES` (32 MiB default), then spill to an append-only temp
  file with a typed offset index and a small LRU read cache.
- **Pipeline**: the materializer runs two passes over the same pinned object version. A *validating pass* coerces every row, discards the
  output and returns the exact row count (a bad workbook fails before anything is written). A *streaming pass* emits NDJSON batches of
  ≤500 rows; the parent consumes the pipe with an async iterator and awaits each insert before reading the next chunk, so the child blocks on
  a full pipe (real backpressure). Peak child RSS is reported with the final line.
- **Persistence**: one `ReadCommitted` transaction (explicit timeout) creates fields, schema version, batch (row count known), rows,
  revision and the active pointer, and completes the job with a lease-fenced update. Failure, cancellation or lease loss rolls everything
  back; a partial dataset is never visible and a retry starts clean. Batches remain append-only.
- **Limits** (`import-limits.ts`): every limit is configurable through `NORTH_DATA_IMPORT_*` variables and clamped to a hard ceiling; invalid or
  non-positive values fall back to the default; there is no unlimited setting. Defaults/ceilings: rows 500k/1,048,576, columns 150/1,024,
  non-empty cells 20M/100M, entry bytes 512 MiB/2 GiB, archive expansion 768 MiB/4 GiB, compressed 50/200 MiB, compression ratio 100/200,
  materialization time 15/60 min, analysis time 5/30 min, parser heap 256 MiB/2 GiB.
- **Migration** `20261009120000_north_dataset_row_ceiling`: relaxes `NorthDatasetImportBatch_rowCount_check` from 50,000 to 1,048,576.

## Measured (local, Node 24, embedded PostgreSQL 16)

| Workload | Time | Memory |
| --- | --- | --- |
| Analysis of the 192,799-row / 296 MB-worksheet workbook | 7.1 s | child 78 MiB RSS |
| Validate + stream the same workbook (no database) | 9.7 s | child 171 MiB RSS |
| Full import into PostgreSQL (validate, stream, insert 192,799 rows) | 49 s | worker 353 MiB RSS (tsx included) |
| Generated 183,040-row workbook, full import | 15.9 s | worker 209 MiB RSS |

Aggregate queries over the imported 192,799 rows ran in 0.3–1.8 s against the 5 s statement timeout; distinct counts matched an independent pandas
computation.

## Consequences

- SheetJS is no longer on the production import path (it remains a dependency for fixture generation and the smoke script).
- The query engine still scans jsonb rows. Heavier distinct/group queries approach 2 s at ~200k rows; a materialized/typed column store or
  indexes are the next step before multi-million-row tenants.
- Chunked multipart upload and append/merge activation modes are still open follow-ups.
