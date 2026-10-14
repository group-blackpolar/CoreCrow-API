# Dataset query baseline (2026-10-15)

Reproduce: `TEST_DATABASE_URL=postgresql://…/xxx_test PERF=1 pnpm exec tsx --test tests/perf-queries.integration.test.ts`
(opt-in; skipped in normal runs). It imports generated XLSX files through the production materialization worker and times
`POST /datasets/:id/query` through the full HTTP stack (`app.inject`: auth, authorization, validation, SQL, serialization).

Conditions: Windows 11 laptop, embedded PostgreSQL 16 on loopback (not the production VPS), single client, 25 runs per query
(the first is reported separately as "first" = cold plan/cache), 3 columns (DATE, TEXT with 1,000 distinct values, DECIMAL).

| rows | query | first ms | p50 ms | p95 ms |
|---|---|---|---|---|
| 12,000 | total (COUNT) | 33 | 11 | 18 |
| 12,000 | top 20 consignees (GROUP BY text, SUM) | 22 | 17 | 24 |
| 12,000 | monthly series (GROUP BY month) | 23 | 34 | 81 |
| 12,000 | filtered by consignee (EQ) + SUM | 15 | 11 | 32 |
| 12,000 | table page (50 rows, ordered, with total) | 35 | 59 | 79 |
| 12,000 | import (stream + materialize) | 1274 | - | - |
| 120,000 | total (COUNT) | 34 | 41 | 110 |
| 120,000 | top 20 consignees (GROUP BY text, SUM) | 83 | 87 | 98 |
| 120,000 | monthly series (GROUP BY month) | 123 | 93 | 140 |
| 120,000 | filtered by consignee (EQ) + SUM | 36 | 36 | 55 |
| 120,000 | table page (50 rows, ordered, with total) | 194 | 198 | 231 |
| 120,000 | import (stream + materialize) | 6080 | - | - |

Reading: aggregations and filters stay under ~150 ms at 120k rows, the ordered table page is the slowest (~200 ms: it sorts
the typed JSON value of every row). All are far below the 1 s target, so no index or materialized view was added: an index
on `values -> field` would have to be created per field and the data does not justify it yet. Re-measure with the real
Shark/Master House volume on the VPS before changing anything.
