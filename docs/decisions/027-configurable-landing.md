# 027 — Configurable landing and Homepage Builder (Phase 2) — PROPOSAL

Status: proposed, not implemented. Needs owner approval of the decisions marked **D1–D5**.

## 1. What exists today (verified in the repository)

| Piece | Where | Finding |
| --- | --- | --- |
| Pages as documents | `NorthPanel` + `NorthPanelRevision` (`draftRevisionId` / `publishedRevisionId`, `revisionNumber`, `message`) | Draft, publish and restore-by-revision already exist and are audited. |
| Page components | `content-schema.ts` catalog: heading, rich_text, image, video, link, file, table, card, list, metric, bar/line/donut chart, document_workspace, hero, panel_group, `report_cards` | This is already the Homepage Builder's block library; edited in Views Studio. |
| Visibility | `NorthPanelAudience{Role,Group,Membership}` + `audienceType` | Per-role / per-group visibility already enforced server-side. |
| Home pointer | `Organization.homePanelId`, `PATCH` route in `north-content.ts:336`, selector in `OrgSettingsScreen` | Only says *which panel*; not *what kind of landing*. |
| Seeded home | `bootstrapNorthOrganization` creates system category `home` (+ `overview/home` panel) for every org; `provision-documents` hides it with `navigationHidden` and points `homePanelId` at the workspace | Standard home is a side effect of provisioning. |
| Landing selection (the hardcode) | `North-BP/src/App.tsx` `CatalogSync`: `categories[0]` | The "landing" is whatever navigation order puts first. No stored intent. |
| Fallback home | `ViewsRenderer.tsx:574` renders built-in `OrganizationHome` when category slug is `home` and the panel has no document | Hardcoded by slug `home`; acceptable only as a fallback. |

Conclusion: ~80 % of the Homepage Builder exists. Phase 2 should add a **landing policy**, not a second page system.

## 2. Design

### 2.1 Landing policy (new, small)

New table `OrganizationLanding` (one row per org, absent = legacy behaviour, see §4):

```
organizationId  PK/FK  (Restrict)
mode            enum   STANDARD | PANEL | NONE            -- D1
defaultPanelId  FK (panelId, organizationId) NULL         -- required when mode=PANEL
updatedBy, updatedAt
```

and `OrganizationLandingRule` for differentiated landings:

```
id, organizationId, order int
audienceType    ROLE | GROUP                              -- reuses the panel-audience vocabulary
role / groupId  (exactly one)
panelId         FK (panelId, organizationId)
@@unique(organizationId, order)
```

- `STANDARD`: the system `home` panel (built-in `OrganizationHome` fallback when it has no document).
- `PANEL`: any PUBLISHED panel of the org (this is the "custom dashboard" and "specific module" options: a module is a panel whose document holds a `document_workspace` / `panel_group`).
- `NONE`: no landing page; North opens the first navigable entry **and says so explicitly** (no implicit `categories[0]`).
- Rules: first matching rule wins (ordered), else `defaultPanelId`/mode. A rule is only usable if the target panel is visible to that audience (validated on write, like `HOME_PANEL_INVALID` today).

`homePanelId` stays as a deprecated mirror of `defaultPanelId` for one release (read-only compatibility, same pattern as `iconData`/`iconAssetId`).

### 2.2 Resolution (server-authoritative, deterministic)

`GET /v1/organizations/:organizationId/landing` → `{ mode, target: { categorySlug, subcategorySlug, panelSlug } | null }`

1. Authorize as member (404 otherwise, as everywhere).
2. Walk rules in `order`; first whose role/group the actor holds **and** whose panel passes `audienceAllows` wins.
3. Else the default; if its panel is not allowed to the actor, fall through to NONE behaviour.
4. NONE → `target: null`, North uses the first authorized entry from `/navigation`.

North `CatalogSync` replaces `categories[0]` with this call (cached with the `navigation` tag, invalidated by landing writes). Permission: `north.category.update` for writes (reuses the existing capability; no new one needed for landing).

### 2.3 Homepage Builder = existing Studio, extended

No new editor. Gaps to close in the existing document model:

- Block gaps: `stat` already covered by `metric`; **quick_links** block (list of internal targets by slug, validated server-side) and a **navigation_cards** block that renders from `/navigation` (generalises `report_cards`). Everything else in the brief (cards, tables, charts, text, images, modules) exists.
- Order / hide / per-block audience: section order exists; add optional `visibility: { roles?, groupIds? }` per component, filtered **server-side** in `content/resolve` so hidden blocks never reach the client (D3).
- Draft / publish / restore: already provided by revisions; Phase 2 only adds the UI entry point "Landing" in org settings.

### 2.4 North

- `features/admin-center`: new "Landing" section in `OrgSettingsScreen` (mode radio, panel picker, ordered rules). Replaces the single `homePanelId` select.
- Remove slug-based special cases from the landing path (`CatalogSync`); keep `OrganizationHome` only as the STANDARD fallback.
- i18n es/en; scroll rule respected.

### 2.5 API contract

Add to OpenAPI: `GET/PUT /organizations/:id/landing` (PUT replaces mode + default + rules atomically, `If-Match`/`updatedAt` for concurrency), errors `LANDING_PANEL_INVALID` (422), `LANDING_RULE_CONFLICT` (409). Audit action `NORTH_LANDING_UPDATED` with before/after summary.

## 3. Decisions requested

- **D1 Modes.** STANDARD / PANEL / NONE (recommended). Alternative: keep only `homePanelId` nullable (NULL = none) — smaller, but cannot express "standard" vs "none" nor rules.
- **D2 Rules by role and group only** (recommended; matches the brief and reuses audience semantics). Per-individual rules are excluded.
- **D3 Block visibility enforced in `content/resolve`** (server removes blocks) rather than hidden in the client. Needs a `schemaVersion` bump of the document (additive, old documents valid).
- **D4 Reuse panels/revisions instead of a new page-versioning system** (recommended: zero duplicate storage, existing audit and restore).
- **D5 `homePanelId` deprecation:** mirror for one release, drop afterwards.

## 4. Migration and compatibility

1. Additive migration: two tables, one enum. No existing column changes. Reversible (`DROP` both).
2. Backfill script (idempotent, dry-run first, run in-process on the VPS after a `pg_dump -Fc`): for each org, `homePanelId` set → `PANEL` + that panel; else if the system `home` panel has a published revision with a document → `PANEL`→home; else `STANDARD`. Current behaviour of SHARK (Home with `report_cards`) is preserved because its `homePanelId` already points at it.
3. Orgs without a row behave exactly as today until backfilled (no flag day).
4. Rollback: ignore the new tables; `homePanelId` is still written during the mirror release.

## 5. Tests (acceptance)

CoreCrow integration: mode persistence; PUT validation (unpublished / foreign-tenant / unauthorized-audience panel → 422/404); rule precedence by role and by group; user without audience falls to default/NONE; cross-tenant panel id rejected; concurrent PUT conflict; backfill idempotency and "legacy orgs resolve identically before and after".
North `node --test`: landing target → route mapping; NONE never opens an implicit category without a notice.
Manual (not yet done): switch modes in a real browser with two roles.

## 6. Out of scope for Phase 2

Stress Test provisioning (Phase 3, will use this API through normal provisioning); any org-specific component or `organization === ...` branch.

## 7. Implementation status (2026-11-17)

Approved D1–D5 as proposed. Implemented and tested (CoreCrow `tests/landing.integration.test.ts`, 9 checks; authorization matrix and table-ownership still green):
- tables, migration `20261117120000_organization_landing`, `GET/PUT /organizations/:id/landing`, `GET .../landing/resolve`, audit `NORTH_LANDING_UPDATED`, panel-in-use guard (`LANDING_PANEL_IN_USE`), `homePanelId` mirror (D5).
- Change to §4: no backfill script. Organizations without a row are *derived* at read time (`homePanelId` set → PANEL, else STANDARD), which is identical to today's behaviour and cannot drift. A row is created on the first save.
- Reads of the policy need `north.category.update` (403 for others, like the rest of the NORTH taxonomy routes); `resolve` needs membership only.
- NORTH: `CatalogSync` resolves the landing from the API (falls back to the first category on NONE or on error); `LandingEditor` in Organization settings > Preferences. Not yet exercised in a browser.

Not done yet (still Phase 2): D3 per-block visibility in `content/resolve` + document `schemaVersion` bump, and the `quick_links` / `navigation_cards` blocks. Migration not applied to production.

### Update — D3 and blocks (2026-11-17)
- D3 implemented without a `schemaVersion` bump: `visibility` is an optional component field (additive; old documents stay valid). `filterDocumentForViewer` runs on member `content/resolve`, on the member binding-results path and on the public showcase (anonymous never receives a restricted block). The rules are stripped from what is delivered; `panel_group` members that were filtered are removed. Tests: `tests/document-visibility.test.ts` (4) and `tests/component-visibility.integration.test.ts` (3).
- Limit (by design): visibility is a presentation control. Dataset access stays governed by dataset ACLs; a bound block hidden from a viewer is also refused on the member results path, but the same dataset can still be reached through another panel the viewer is allowed to read.
- Blocks: no new component types. `quick_links` already exists as `link_cards` (now addable in the Studio with an editor) and navigation-driven cards already exist as `report_cards` (category slug + `report-access` state) plus the built-in generic Home. Creating a third type would duplicate them.
- NORTH: Studio inspector "Visibility" group (roles + groups) and `LinkCardsFields`. Not exercised in a browser.
