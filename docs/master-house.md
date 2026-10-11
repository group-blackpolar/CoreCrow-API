# SHARK · Master House — metrics, data audit, query engine and assistant tools

Scope: CORECROW side of the Master House report (eight panels in the existing category `master-house`). Declarative definition:
`scripts/dashboards/shark-master-house.mjs`; provisioner: `scripts/provision-view.mjs` (public API with the caller's own session;
idempotent by slug/binding name; retries on 429).

## Metric definitions (audited against the source workbook, 192,799 rows, 2024-01-01 → 2026-08-31)

| Measure | Definition | Why |
| --- | --- | --- |
| Containers | `COUNT_DISTINCT container_number` | a container can appear in several Master/House rows (147,554 distinct in 192,799 rows) |
| Weight (MT) | `SUM master_weight_mt` / `house_weight_mt` | per-container allocation of the BL weight, so it sums safely |
| Master / House TEUs | `SUM master_teus` / `house_teus` **`distinctBy` the BL number** | the TEU value belongs to the BL and is repeated on every container row of that BL |
| House Metric Tons | `SUM house_metric_tons` `distinctBy` house BL | BL-level value, same reason |
| Period | `arrival_date` (month / year buckets) | the only date in the dataset |

`distinctBy` (new, additive in the dataset query contract, `SUM` only): within each group, every key contributes **the MAX of its rows once**.
MAX (not "first row") matters because Master TEUs are blank on 62,982 rows (33 %) and 21,671 BLs have blank repeats: a first-row rule
undercounts (measured 174,383 vs the true 275,394).

Verified against an independent pandas computation of the same workbook (exact): total containers 147,554; Master TEUs 275,394;
forwarders 1,295; ETERNITY INTL 10,920 containers / 20,260 TEUs; KRYSTAL 10,447 / 17,846; DHL 9,560 / 18,136. A plain `SUM` would have shown
ETERNITY INTL at 28,241 TEUs (+39 %) and Master TEUs overall at 355,681 (+29 %).

### Dimension decisions (spec inconsistencies resolved)

* **Freight forwarder** = `master_consignee`. The largest Master Consignees are forwarders/consolidators (KUEHNE NAGEL, DHL, ASWW …); the House Consignee is the cargo owner.
* **Country of origin**: Master and House differ on ~16 % of rows, so a panel never mixes them. Search By, House list and Cargo table use the House side; Master list, Port of Departure, Consignees table (country filter) and Top Forwarders use the Master side.
* **03 Master Consignee List**: the reference table was titled "Containers and Weight (MT)" but showed no weight. The table now carries Containers, Master TEUs and Master Weight (MT) and the title says so.
* **05 Search by Port of Departure**: the reference listed the port of *arrival* on a page named after the port of *departure*. Both ports are filters and table columns, plus the "Containers per Entry Port" donut, so every column matches its header.
* **Year vs Month/Year filters**: one period control (months and years that actually hold data, presets, custom range) covers both.
* **Shipper** does not exist in this dataset. The assistant says so and lists the real fields instead of substituting one.

### Data finding to act on (not changed by this work)

The production dataset was imported with duplicates kept (`duplicates: KEEP`): 9,759 rows (5.06 %) are exact duplicates. Containers are unaffected
(distinct), but weights are overstated: House Weight +4.87 % (1,798,466 vs 1,715,002 MT), Master Weight +4.98 %, House Metric Tons +5.16 %.
The import wizard already defaults to "skip exact duplicates"; **re-importing the workbook with that option fixes the totals** (no code change).

## Query engine (performance)

Aggregates used to sort the full JSON row (~1.5 kB) of all 193 k rows (external merge sort, ~290 MB on disk). They now project the referenced
fields once into a `MATERIALIZED` CTE (a few short columns per row) and run the grouping on it, with `SET LOCAL work_mem` (default 64 MB,
`NORTH_DATASET_QUERY_WORK_MEM_MB`). Same results; measured:

| Measurement (193 k rows) | Before | After |
| --- | --- | --- |
| Production PostgreSQL, containers by Master Consignee (read-only `EXPLAIN ANALYZE`) | 4,297 ms | 1,127 ms |
| Production, containers + TEUs by Master Consignee (distinct by BL) | 8,127 ms | 1,984 ms |
| Production, total unique containers | 10,086 ms | 2,260 ms (work_mem only) |
| Production, monthly weight series | 1,389 ms | 396 ms |
| Real API, cold dashboard load of the same bindings (6 concurrent), 8 panels, local PostgreSQL | 35,952 ms total | 10,613 ms total (**3.4×**) |

Per panel (before → after, ms): overview 2112 → 693 · Search By 5898 → 1683 · Master list 5437 → 1411 · House list 5751 → 1730 ·
Port of Departure 7312 → 2215 · Cargo table 3285 → 884 · Consignees 2935 → 983 · Top forwarders 3222 → 1014.

Production after the deploy (cold, result cache bypassed, one request at a time, median of 3, read-only, through the real service): per-binding
latency 1.3–3.0 s; sequential sum per panel — overview 2.7 s, Consignees 5.1 s, Cargo table 6.3 s, House list 7.1 s, Top forwarders 8.1 s, Search By 8.4 s,
Master list 8.9 s, Port of Departure 11.6 s. A browser fires them with 4 in flight server-side, so a cold panel renders in roughly 3–5 s; repeats inside 10 minutes hit the cache.
These production panel numbers have no "before" (the old engine could not run the new bindings); the like-for-like before/after is the table above.

Already in place and kept: 10-minute result cache keyed by tenant/panel/binding/user/active revision, concurrency gate (4), statement timeout,
server-side paging/sorting/search, per-request cancellation and last-valid-result in the client. Not done (not justified by the measurements):
materialized views, expression indexes (every query scans the single active revision; the plan is a parallel seq scan + hash join, the cost was the sort width).
Server tuning left to the operator: `shared_buffers` is 128 MB and `work_mem` 4 MB on the VPS PostgreSQL.

## Assistant (Cuervo) — real tools

All run as the signed-in user through the product's own services (published-panel audience/permission checks, dataset ACL, declared filter allowlists).

| Tool | Risk | What it does |
| --- | --- | --- |
| `views.navigation.list` | read | dashboards the user may open (ids, names, slugs) |
| `views.panel.describe` | read | components + data sets, output columns and filterable fields (key, label, type, operators) |
| `views.values.search` | read | real values of a filter field with counts (resolves ambiguity / exact spelling) |
| `views.panel.query` | read | rows (max 25) + total with filters, sort, text search |
| `views.apply_filters` / `views.clear_filters` / `views.open_panel` | read | validate, count, and return a **UI directive** NORTH executes (open panel, set filters) |
| `views.category.create` / `views.subcategory.create` | mutation | **proposed** as a pending action; run only after the user confirms |

Guarantees: unknown field/operator/data set → structured error fed back to the model (it must tell the user and offer the real fields; no silent substitution);
text search is never degraded to an exact match; mutations are owner-bound, single use, expire in 10 minutes, are authorized at proposal **and** again at confirmation,
and audited (`ai.action.proposed/confirmed/failed`); a plain MEMBER cannot even propose them. Tested in `tests/ai-tools.integration.test.ts`.

## Chat bug (root cause)

`GET /v1/ai/runs/:id/events` hijacks the Fastify reply to stream SSE. `reply.hijack()` + `raw.writeHead()` drops the headers `@fastify/cors` had queued, so the browser
(NORTH → api.blackpolar.org is cross-origin) blocked reading the response: the run completed and was persisted, but `fetch` failed with a network error, the client retried
5 times with `after=0` (production nginx log, 2026-10-09 09:04: four `200 2366` replays of the same run, 13 events, status COMPLETED) and showed "something went wrong". A reload read the stored
conversation, hence the answer appeared. Also fixed: a full batch of 100 events closed the stream before the terminal event was sent, and the reconnect budget was consumed even when progress was made.
Client: a lost stream now asks CORECROW for the run status and reloads the stored conversation instead of reporting a failure. Regression test
`tests/ai-stream.integration.test.ts` fails without the fix.

## Provisioning runbook

```
NORTH_API_URL=https://api.blackpolar.org NORTH_ORIGIN=https://north.blackpolar.org \
NORTH_SESSION_COOKIE='<cookie header of a signed-in OWNER/ADMIN session>' \
node scripts/provision-view.mjs scripts/dashboards/shark-master-house.mjs --org shark --publish [--only <panel-slug>]
```

Updates the eight existing panels in place (new draft revision, validated by CORECROW, then published); previous revisions stay restorable from the panel's revision history.

Server-side without a session (what was done for the 2026-10-11 production run): `--in-process --actor <email> --dist /app/dist` executes the same operations through the application
services as that member account (authorization, validation and audit are that actor's; nothing is bypassed and no session is created):

```
docker cp scripts corecrow-v1:/tmp/prov
docker exec corecrow-v1 sh -c "cd /tmp/prov && node provision-view.mjs shark-master-house.mjs --org shark --in-process --actor <email> --dist /app/dist --publish"
```

Production run 2026-10-11: pre-run `pg_dump -Fc` (`/var/backups/blackpolar/pre-master-house-20261011T234408Z.dump`, 577 entries), actor `group@blackpolar.org` (OWNER of SHARK, platform SUPERADMIN),
eight panels published at revision 3 (`rowHeight` 16, `fit`), audit: 47 bindings created, 47 updated, 8 `PANEL_PUBLISHED`. The bindings of the previous tooling remain on the panels, unreferenced.
Rollback: restore each panel's previous revision from NORTH's revision history, or `pg_restore` the dump above.
