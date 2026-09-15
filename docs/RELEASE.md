# Release and verification

## Verified locally

The foundation migration applied to an isolated PostgreSQL 16 database. Integration tests exercise actual Better Auth signup, email delivery to a loopback SMTP sink, verification, login, sessions, tenant isolation, role denial, last-owner protection, invitation recipient/replay/revocation/expiry, transactional audit rollback, database audit immutability, API-key scope/ownership/revocation, idempotent contract provisioning, entitlement cancellation, consent, CORS/CSRF, and sign-out.

`pnpm build`, `pnpm lint`, and `pnpm test` are executable checks. `pnpm openapi` generates the checked-in JSON/YAML contract from the same route schemas. CI runs migrations and tests before allowing the deployment job. Provider schemas are available at `/v1/auth/open-api/generate-schema`.

## Before deployment

1. Back up production PostgreSQL and identify the existing operator's Better Auth credential migration. Legacy admin login is disabled by default. If existing verified operators have no Better Auth credentials, temporarily enable the audited enrollment bridge described below.
2. Set `DATABASE_URL`, a strong `BETTER_AUTH_SECRET`, HTTPS `BETTER_AUTH_URL`, exact `TRUSTED_ORIGINS`, `SMTP_URL`, and `MAIL_FROM` on the backend host. Update the Google callback to `/v1/auth/callback/google` if enabled. Do not put secrets into either frontend.
3. Run `pnpm db:migrate:deploy` or the verified release workflow. The migration is additive for existing data and backfills OAuth expiry; do not edit applied migration SQL.
4. Build/start the new API, verify `/v1/live`, `/v1/health`, `/v1/status/summary`, root HTML and a real email verification flow. Readiness is degraded if SMTP configuration is missing or the transport connection cannot be verified; successful SMTP verification is still not a recipient-delivery guarantee. Email-dependent requests return 503 before mutation while mail settings are missing.
5. Bootstrap an operator only if necessary with `pnpm create-admin`. Existing verified operators can retain their accounts; ensure a Better Auth credential is present before switching clients.
6. Deploy Mainsite with `NEXT_PUBLIC_CORECROW_URL=https://api.blackpolar.org` (also the default). The public form submits with no auth cookies. Test a controlled contact submission and inspect it through the operator API.

The runtime now uses PostgreSQL sessions. Redis remains in Compose only under the `legacy` profile to preserve its existing volume; no Redis data is deleted. The inspected VPS uses the existing `corecrow-api_default` Docker network and database. `scripts/deploy-vps.sh` builds an immutable release, backs up PostgreSQL, applies migrations, checks a candidate on loopback 4101, and runs `corecrow-v1` on loopback 4100. Runtime settings live in root-readable `/etc/blackpolar/corecrow.env`. nginx must target 4100 after initial rollout. The old API on 4000 is preserved during the migration. Future releases keep the previous v1 container for rollback. GitHub Actions bundles the verified commit into a new release directory, without resetting the old server checkout.

## Existing operator enrollment

The inspected VPS has verified legacy operators without Better Auth credential accounts. For this migration only, set `ENABLE_LEGACY_ADMIN_AUTH=true`. An operator submits their own email and existing identifier to `POST /api/admin/login`, then uses the returned Bearer session with `POST /v1/identity/legacy-migration` and `{ email, password }`. Passwords must contain 12–128 characters. Enrollment atomically adds a Better Auth credential, clears the legacy identifier, revokes all existing sessions, and audits the change. Sign in through `/v1/auth/sign-in/email` afterwards. Never send credentials to support or store them in deployment scripts. Disable the bridge after all operators enroll. Discovery and unauthenticated initialization remain retired.

## External verification

Local verification does not certify the production environment. No production database migration, payment transaction, SMTP delivery to real recipients, Google OAuth callback, nginx reload, PM2 reload, Docker image build, GitHub workflow run, or deployment has been performed as part of the local test suite. Payment providers, recurring billing and license/seat policy remain outside the implemented contract-provisioning slice.

Database audit triggers require an application DB role that cannot alter schema for strong operational separation; schema-owner credentials can bypass those controls. Configure bounded PostgreSQL connection/statement timeouts. Do not expose the database port publicly.
