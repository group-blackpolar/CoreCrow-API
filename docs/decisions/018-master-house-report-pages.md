# Master House report pages and demo viewers

- Status: Retired in Task Pack 12 (2026-10). The provisional seed, fixture and report pages were removed from the codebase; production data is untouched and handled by a separate, authorized runbook (docs/task-pack-12/LEGACY_CLEANUP.md in the NORTH repository).
- Date: 2026-10-05
- Scope: CORECROW trusted demo seed

## Decision

The trusted June demo seed publishes the Master House report as eight ordinary
CORECROW panels (one subcategory each) under a `master-house` category in the
isolated demo organization (`shark`). Every table and chart reads an
authoritative analytics binding over the active dataset revision; NORTH renders
typed results only. No NORTH-owned endpoint, fixture or client-side query exists.

The fixture carries eighteen presentation fields (master and house) of a synthetic data set shaped like
the June workbook. It is generated offline (fully synthetic) with
`scripts/build-demo-fixture.mjs`; the API never parses a workbook. A
changed fixture has a new checksum, so the seed records it as a new import and
activates a new dataset revision. Existing field IDs, bindings and the original
`analytics/master-house/june-2026` panel are preserved.

Read-only access is provisioned by `--viewer-emails`: each address must already be
an active, verified account and receives a `VIEWER` membership when it has none.
The seed never creates accounts or credentials and never changes an existing
role. Panels use the `ALL_MEMBERS` audience and the dataset keeps its
`ALL_MEMBERS` ACL, so default-deny still applies to non-members.

## Known limits

- Aggregate queries allow two group keys and 100 rows; tables show top rows, not
  Looker-style pagination, and the world map is replaced by ranked charts.
- Filters are text/exact controls; there is no distinct-value picker contract.
- The seed is a controlled exception. General XLSX upload stays fail-closed until
  versioned object storage, the scanner and the import worker are provisioned.
