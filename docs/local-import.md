# SHARK · Local Import report

Definition: `scripts/dashboards/shark-local-import.mjs` (provision with `scripts/provision-view.mjs ... --org shark --publish`). Category `local-import`, dataset `local-import`
(21 fields, 615,699 rows, dates 2025-01-01 .. 2026-04-30 at the time of writing). Only existing fields are used; nothing is added or derived by hand.

## Metrics

| Metric | Definition |
| --- | --- |
| Gross Weight (Kg.) | `SUM gross_weight_kg` |
| CIF Value (USD) | `SUM cif_value_usd` |
| Freight (USD) | `SUM freight_usd` |

Not audited for duplicate rows (the CTR report needed distinct rules for TEUs; this dataset has no equivalent bill-level value).

## Pages (9)

The customs-clearance location is a fixed page filter on `transport_method`: SEA = Maritime, LAND = Overland / Bonds, AIR = Air. One design, three categories.

| Page | Slug | Filters | Components |
| --- | --- | --- | --- |
| Info | `info` | none | empty title bar, centered hero with logo, notes, three location cards, the two views, Privacy Policy link |
| HS Code | `hs-code` | HS Code, HS Description, Importer, Transport Method, Month / Year | detailed table (year, month, importer, HS code, HS description), sorted by HS code |
| Maritime / Overland / Air · Category | `<loc>-category` | Country of Precedence, Port of Arrival, Month / Year, HS Description, Importer | country table with Grand total, CIF bubble map, gross-weight donut by place of arrival, importers table with Grand total |
| Maritime / Overland / Air · Importer Card | `<loc>-importer` | Importer, Month / Year, Port of Arrival, Country of Precedence | KPIs (gross weight, CIF, freight), gross-weight bubble map, donut, top-10 HS description bars, monthly line (2025 blue, 2026 light blue) |
| Maritime · Imports Table | `maritime-imports-table` | Importer, Month / Year, HS Description, Port of Arrival, Country of Precedence | detailed table (year, month, importer, HS description, country, port, gross weight, CIF) |

## Differences from the specification

- **Transport Method filter** appears only on HS Code. On the location pages the method is fixed, so a selector would only produce empty results.
- **Product Description** (importer bars) uses `hs_description`; the free-text `description` field has very high cardinality.
- **Zona Libre de Colón**: the Info text says ZLC is excluded, but the dataset has 274,359 rows with port `ZONA LIBRE DE COLÓN`. They are shown as loaded; excluding them would be a data decision.
- **"Data through" month** on the Info page is static text (April 2026); update it when a newer import lands.
- **Map**: country bubble map of NORTH (no Street View). Donut legends show the top 5 and "Otros", without pagination. Line charts have no data labels.
- **Overland / Bonds and Air** have Category and Importer pages only, as specified (no Imports Table).
- **Empty title bar** on Info holds a zero-width space because the document schema rejects blank text.
