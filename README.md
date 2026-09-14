# CORECROW API

Black Polar's shared backend foundation: Fastify + TypeScript + PostgreSQL + Better Auth. Mainsite and product clients communicate through versioned HTTPS APIs. Only backend repositories own persistence.

## Start locally

Use Node 22+ and pnpm 9.15.0. Copy `.env.example` to `.env` and configure a local PostgreSQL database, a strong auth secret, trusted origins, and SMTP. The process does not auto-load `.env`; use your process manager, `node --env-file`, or `tsx --env-file=.env src/server.ts`.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate:deploy
pnpm build
node --env-file=.env dist/server.js
```

Email/password signup requires email verification. Without SMTP, the API starts with degraded readiness and email-dependent requests return 503 before creating accounts. For the first operator, register/verify through Better Auth, then run `pnpm create-admin` on the backend host with environment variables loaded. The CLI promotes an existing verified identity; it never creates an identifier-only login.

## Contracts

- `GET /`: public HTML status dashboard; `/health` is an HTML alias. Readiness and process uptime come from the existing health service. Traffic rate, latency, HTTP error totals, and historical charts remain explicitly unavailable until an aggregated telemetry contract is approved and implemented; the production page does not invent these values.
- `GET /v1/live`: process liveness.
- `GET /v1/health`: dependency/configuration readiness (503 when degraded).
- `GET /v1/openapi.json`: generated application contract.
- `GET /v1/auth/open-api/generate-schema`: Better Auth's own endpoint schemas.
- `/v1/auth/*`: email/password, verification, recovery, Google when configured, sessions, revocation.
- `/v1/me`, `/v1/users`: identity/profile operations and protected operator administration.
- `/v1/organizations/*`: organizations, memberships, invitations, effective permissions, tenant audit, subscriptions, entitlements.
- `/v1/invitations/accept`: recipient-bound, single-use invitation acceptance.
- `/v1/security/keys`: self-owned read-only API keys with explicit scopes.
- `/v1/commerce/*`: products, plans, audited contract provisioning, cancellation.
- `/v1/contact`: public consented submission; operator-only audited GET for follow-up.

Application errors use `{ error: { code, message, requestId } }`. Better Auth retains its provider error contract. Schemas reject unrecognized request properties. List limits and supported parameters are specified in OpenAPI. Responses project only contract fields, excluding hashes and authentication credentials.

## Implemented boundaries

`src/contracts` owns shared HTTP schemas; `src/routes/v1.ts` maps requests to module services. `src/modules` separates identity, authorization, tenancy, audit, security, commerce, business services, and health. Repositories use Prisma; application services orchestrate transactional invariants. There is no NORTH, ARCTIC FOX, ERMINE, or SNOWY OWL application implementation here.

Tenant authority comes from current membership, never a browser-supplied role. Global administrators do not bypass tenant reads. Sensitive application mutations commit with audit records; PostgreSQL rejects audit mutation. Contract commerce uses exact minor units, explicit entitlement grants, idempotency, and atomic cancellation. It does not collect payments or implement a payment provider, recurring billing, purchases, or seat-license policy.

## Verification

```sh
pnpm build
pnpm lint
pnpm test:unit
pnpm openapi
```

Full tests require `TEST_DATABASE_URL` pointing to a dedicated loopback PostgreSQL database whose name ends in `_test`. Tests never infer or reuse `DATABASE_URL`. After migrating that test database, run `pnpm test`; the integration suite uses an ephemeral loopback SMTP sink. Without `TEST_DATABASE_URL`, the database suite is explicitly skipped. `scripts/test-database.mjs` can start a local PostgreSQL 16 test instance at 127.0.0.1:55432 without Docker. Stop it with Ctrl+C; its data is under ignored `node_modules/.cache`.

See [implementation decisions](docs/decisions/006-v1-foundation.md) for session/role/commerce choices and limitations, and [release notes](docs/RELEASE.md) for verification and deployment prerequisites. [The old README](docs/legacy-baseline.md) is retained only as historical reference; its endpoint and security descriptions no longer apply.
