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

Email/password signup requires a six-digit, single-use email verification code. Codes expire after 10 minutes, are stored only as keyed hashes, allow five validation attempts, and are replaced by resend. Without SMTP, the API starts with degraded readiness and signup fails before creating an account. To configure the superadmin, first register and verify a Better Auth credential identity, then run `pnpm create-admin` on the trusted backend host. The command prompts for the target email and a hidden permanent admin secret, stores only a password-grade hash, revokes that identity's sessions, and can safely rotate the same identity's secret. For non-interactive secret-manager integration, inject `CORECROW_BOOTSTRAP_EMAIL` and `CORECROW_ADMIN_SECRET` only into that command's process environment; never place the secret in arguments, logs, source, or deployment files.

## Contracts

- `GET /`: public HTML status dashboard; `/health` is an HTML alias. Readiness, verified SMTP connectivity, process uptime, traffic, latency and HTTP error aggregates come from live services. Telemetry coverage restarts with the process and is labeled accordingly; the page never invents historical availability.
- `GET /v1/live`: process liveness.
- `GET /v1/health`: dependency/configuration readiness (503 when degraded).
- `GET /v1/status/summary?window=1h|6h|24h`: public, sanitized five-minute traffic buckets. It returns counts and latency histograms only—never paths, tenant identifiers, IPs, headers or bodies.
- `GET /v1/openapi.json`: generated application contract.
- `GET /v1/auth/open-api/generate-schema`: Better Auth's own endpoint schemas.
- `/v1/auth/*`: Better Auth email/password identity, recovery, Google when configured, sessions, and revocation. Signup sends the Black Polar verification code rather than a verification link.
- `POST /v1/identity/verification/send`: generic `{ accepted: true }` resend response for known and unknown addresses; rate limited to 10 requests per minute per resolved client address.
- `POST /v1/identity/verification/confirm`: confirm `{ email, code }`; success returns `{ verified: true }`, while unknown, expired, replaced, reused, or invalid codes share `400 INVALID_OR_EXPIRED_VERIFICATION_CODE`; rate limited to 20 requests per minute and each issued code permits five validation attempts.
- `POST /v1/admin/sign-in`: rate-limited operator sign-in with email and permanent admin secret; success is delivered only as an HttpOnly session cookie.
- `POST /v1/me/change-temporary-password`: authenticated one-time replacement of a recovery password; it preserves the current browser session and revokes the user's other sessions.
- `/v1/me`, `/v1/users`: identity/profile operations and protected operator administration.
- `/v1/organizations/*`: organizations, memberships, invitations, effective permissions, tenant audit, subscriptions, entitlements.
- `/v1/organizations/{organizationId}/north/*`: authorized taxonomy, panels,
  revisions, assets, scoped grants, templates, batch ordering, and tenant search.
- `/v1/platform/north/templates`: versioned global template management for
  explicitly authorized platform administrators.
- `/v1/invitations/accept`: recipient-bound, single-use invitation acceptance.
- `/v1/security/keys`: self-owned read-only API keys with explicit scopes.
- `/v1/commerce/*`: products, plans, audited contract provisioning, cancellation.
- `/v1/contact`: public consented submission; operator-only audited GET for follow-up.

Application errors use `{ error: { code, message, requestId } }`. Better Auth retains its provider error contract. Schemas reject unrecognized request properties. List limits and supported parameters are specified in OpenAPI. Responses project only contract fields, excluding hashes and authentication credentials.

The unversioned `/api/*` compatibility surface and legacy administrator identifier flow have been removed. Calls to those paths now receive the standard `404 NOT_FOUND` response. Consumers must migrate to the corresponding `/v1/*` contracts before deploying this release. Recovery-created credentials expose `passwordChangeRequired`; while it is true, protected application operations are denied except reading `/v1/me` and replacing the temporary password.

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

## SMTP

Production mail can use Google Workspace SMTP relay without storing a mailbox password. In Google Admin, authorize only the VPS public IP, restrict allowed senders to registered Black Polar users, and require TLS. Then set `SMTP_URL=smtp://smtp-relay.gmail.com:587?requireTLS=true` and a registered `MAIL_FROM` in the root-readable backend environment. An authenticated `smtp.gmail.com` connection with a dedicated app password is the fallback; percent-encode credentials in the URL and never commit them. Restart CoreCrow and confirm `emailTransport: "available"` at `/v1/health` before testing one controlled verification email.
