# SHARK · Imports CTRs report

Definition: `scripts/dashboards/shark-import-ctr.mjs` (provision with `scripts/provision-view.mjs ... --org shark --publish`). Category `import-ctr`, dataset `import-ctr`
(14 fields, 796,260 rows, arrival dates 2024-01-01 .. 2026-08-31 at the time of writing). Only existing fields are used; nothing is added or derived by hand.

## Metric rules (audited on the production dataset, read-only aggregates)

| Metric | Definition | Why |
| --- | --- | --- |
| Containers | `COUNT_DISTINCT container_number` | 554,345 distinct containers over 796,260 rows (a container repeats across rows) |
| TEUs | `SUM teus` distinct by `bill_of_lading_nbr` | `teus` is a bill-level value repeated on each of its rows and blank on ~32 % of rows; a plain SUM gives 1,497,409 vs 1,448,102 distinct by bill (+3.4 %) |
| Year columns / lines | conditional measures (`when` on `arrival_date`) | one column per year in the same row, NULL (gap / dash) where a year has no rows |
| Month axis | `MONTH_OF_YEAR` granularity | calendar month 1-12 across years, one series per year |

## Pages

| Page | Slug | Filters | Components |
| --- | --- | --- | --- |
| Report Info | `report-info` | none | hero, six cards to the pages, metric definitions |
| Port ("Imports by Port") | `port` | Port of Arrival, Month / Year, Carrier | consignee table, country bubble map, Containers/TEUs KPIs, two donuts, per-year monthly lines |
| Year Comparison | `year-comparison` | Port of Arrival, Consignee, Carrier, Month / Year; page filter: only rows with country of origin | containers by year, grouped bars year x terminal, per-year lines, grouped horizontal bars region x year |
| Consignee Details | `consignee-details` | Consignee, Month / Year (+ Country, Port of Departure) | entry-port bars, line donut, KPIs, monthly line, bubble map, origin table, port-of-departure table |
| Consignees by Port | `consignees-by-port` | Port of Arrival, Consignee, Month / Year | pivot grid consignee x 2024/2025/2026 with Grand total |
| Origin port Detail | `origin-port-detail` | Country, Port of Departure, Month / Year, Carrier | top-10 bars, departure and consignee tables with Grand total, two share donuts, KPI |
| Table Consignees List | `consignees-list` | Consignee, Month / Year, Port of Arrival | detailed grid with Grand total |

Every page has a title bar in the organization's primary colour (navy for SHARK) and the filters apply to all components of the page.

## Differences from the reference (what the platform does not do)

- **Year and Month filters**: the dataset has one date (`arrival_date`); the "Month / Year" control offers month and year choices, so there is no separate Year dropdown.
- **Line charts have no data labels** (bars do). Donut legends do not paginate: the first five slices are shown and the rest is "Otros".
- **Bubble map** is the country bubble map of NORTH (continent legend, zoom +/-); no Street View.
- **Drill-down table** is two tables (country, port of departure) on the same page; selecting a country in the first (row menu "filter") narrows the second.
- **Year columns and the five terminals of the year-by-port chart are fixed in the definition** (they cover 99.5 % of containers). A new year or terminal means editing that component in the Studio.
- **Data quality, not changed**: the port `PANAMA PORTS COMPANY PPC CRISTÃ“BAL` (632 containers) is a mis-encoded duplicate of `... CRISTÓBAL`; they appear as two ports until the source is corrected.
