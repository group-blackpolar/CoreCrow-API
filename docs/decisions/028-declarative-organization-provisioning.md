# 028 — Declarative organization provisioning (Phase 3: Stress Test)

Status: implemented (2026-11-17), not yet run in production.

## Decision
Organizations (and their navigation) are provisioned from a **definition file** by one generic, idempotent reconciler,
`scripts/lib/provision-organization-core.mjs`, driven by `scripts/provision-organization.mjs` over the normal API (session cookie) or
the in-process services transport as a named actor (same as `provision-view.mjs`). It creates the organization through
`tenants.create` (owner = acting account, nobody else), declares categories/subcategories through the taxonomy services, hides the
empty system Home when asked, seeds one published starter panel per subcategory, and sets the landing policy (ADR 027).
Nothing in the code names an organization; **Stress Test is `scripts/organizations/stress-test.mjs`** (data only).

## Behaviour
- Matched by slug, never deleted; re-running converges the *declared* entries (names, icons, order) and leaves extra entries alone.
- Starter panels are seeded once (only when the panel is not yet PUBLISHED); administrators own them afterwards.
- Access: only the acting account is a member; others are added by invitation. Tenant isolation is the normal one.

## Findings
- `GET /navigation` lists only subcategories with at least one *authorized published panel*, so categories without panels are invisible to members.
  Hence the starter panels (`panelPerSubcategory`); they are plain `heading` + `card` content.
- `Organization.name` is a single string: the localized name "Pruebas de Estrés" is stored in `description`. A per-locale organization name
  would need a schema change (not done; decision for the owner).
- Re-running as a non-member is refused (slug taken / no access).

## Verification
`tests/provision-organization.integration.test.ts` (4 checks: creation, second run changes nothing, rename reconciled and extra category kept,
restricted + isolated). The real definition was also run twice in-process against the local test database (35 starter panels, second run all zeros).
Production run: needs an authorized actor and a pre-run `pg_dump`; `node scripts/provision-organization.mjs scripts/organizations/stress-test.mjs --in-process --actor <email> --dist /app/dist`.
