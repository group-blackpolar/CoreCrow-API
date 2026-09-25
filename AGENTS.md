# CORECROW engineering instructions

## Ownership and authority

This repository is the exclusive GBP backend and persistence boundary. It owns shared identity, authentication, organizations, memberships, invitations, server-side authorization, tenant context, audit/security events, business services, integrations, Prisma migrations and PostgreSQL access. NORTH and Main Site consume approved APIs.

Before changing architecture or public behavior, read `../ARCHITECTURE.md`, relevant accepted workspace ADRs in `../docs/adr/`, `docs/adr/0001-personal-scope-and-organization-creation.md`, and applicable records in `docs/decisions/`. Current code, tests and contracts are evidence of implementation. Treat `docs/legacy-baseline.md` and `NIVEL1_SUMMARY.md` as historical when they conflict with current behavior.

## Engineering rules

- Keep HTTP/Fastify presentation thin; application and domain logic must not depend on Fastify, and PostgreSQL access stays behind infrastructure/repository boundaries.
- Authorization is server-side, membership-derived, tenant-aware and default-deny. Do not trust client-selected tenants, roles, entitlements or prices, and do not create a global-admin tenant bypass.
- Security-sensitive and commercial mutations must preserve transactional and audit guarantees. Never log or expose credentials, tokens, hashes, secret headers or local environment values.
- Public contract changes require schemas, stable machine-readable errors, regenerated `openapi.json` and `openapi.yaml`, compatibility analysis and focused negative authorization/cross-tenant tests.
- Add migrations incrementally. Never edit an applied migration, and never substitute `db:push` for production migration deployment.
- Preserve pre-existing changes. Do not inspect or commit `.env` or `.env.baseline`, and do not modify production systems without explicit user intent.

## Tooling and validation

Use pnpm 9.15 and Node 22 for CI parity. Inspect `package.json` before choosing checks. Normal validation is `pnpm build`, `pnpm lint`, `pnpm test:unit`, and `pnpm openapi`; verify that generated OpenAPI files have no unexplained drift. Full `pnpm test` or integration tests require an explicitly isolated loopback `TEST_DATABASE_URL` whose database name ends in `_test`, with migrations applied first. Report skipped checks.

The shared CodeGraph index is at `../.codegraph`. When working from the GBP workspace and that index exists, use `codegraph explore` from the workspace root before broad text search for code-path questions.
