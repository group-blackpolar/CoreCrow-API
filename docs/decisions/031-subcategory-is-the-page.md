# 031 — The subcategory is the page (no "Views" third level)

Status: accepted (step 1 implemented). Date: 2026-11-18.

## Context
`NorthCategory → NorthSubcategory → NorthPanel`. The panel ("view") carries the document, revisions, audience, grants, bindings,
slug aliases and showcase visibility. The sidebar already shows only categories and subcategories and opens the subcategory's first
published panel, so the third level was redundant for readers and for the editor.

Production audit (read-only, 2026-11-18): 70 of 73 subcategories hold exactly one panel; two hold two (`blackpolar/home/overview`,
`seminsa/formas/formas`). `scripts/subcategory-pages-report.sql` lists them.

## Decision (step 1, reversible)
A subcategory **is** a page: it holds at most one non-archived panel, which is its page. No table changes.
- `POST …/subcategories/:id/panels` (and moving or cloning a panel into a subcategory) is refused with `409 NORTH_SUBCATEGORY_PAGE_EXISTS`
  when the subcategory already has a non-archived panel. Existing data with more panels is not touched.
- `POST …/subcategories/:id/page` returns the page (the panel sharing the subcategory slug, else the first by order) or creates it from the
  subcategory's own name and slug. Idempotent; audited as `SUBCATEGORY_PAGE_CREATED`; creating needs `north.panel.create`, reading `north.panel.read`.
- Every `/panels/:id/...` endpoint keeps working (draft, publish, revisions, audience, bindings, export, showcase), so permissions, history,
  bindings and public links are preserved.

## Migration of legacy data
Subcategories with several panels are reported, never deleted: the extra panels are moved to NEW subcategories of the same category (same
content, permissions and slug alias). The choice of which panel stays is explicit per subcategory and needs the owner's confirmation.

## Step 2 (not started)
Collapse the model (move draft/published/audience/bindings to `NorthSubcategory`, retire `NorthPanel`). Only after step 1 runs in production.
