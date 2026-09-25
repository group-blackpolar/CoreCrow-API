# Release and verification

## NORTH TASK 8F: templates, authorized search, and audit correlation (2026-09-30)

- Added immutable, versioned global templates managed by explicit platform
  authority. Applying a template creates a new tenant-owned draft hierarchy,
  remaps section/component IDs, records `sourceTemplateId` and version, and
  never live-updates copies when later versions are created.
- Added tenant-scoped search filters for query, resource type, category, status,
  updater, and update time. Every result is re-authorized; published panel
  results enforce audiences and draft matching requires preview authority.
- Added HTTP request correlation to audit events and retained compatibility for
  existing organization `audit.read` grants while accepting `north.audit.read`.
- Added centrally configurable category/subcategory/panel technical limits.
- Apply `20260930120000_north_templates_audit_request` and
  `20260930130000_north_template_version_immutability` before the application
  image. The migrations are additive. Rollback requires restoring the older
  image before dropping the two template tables or the nullable audit column.
- Dynamic bindings remain fail-closed. Template snapshots reject tenant-bound
  asset references and group/member audiences until an explicit portable
  mapping contract exists. PERSONAL remains system-only; no user-owned personal
  persistence was invented.

## NORTH TASK 8E: tenant assets and object storage (2026-09-29)

- Added tenant-scoped asset metadata, lifecycle states, soft deletion, and
  auditable organization quota reservation/commit/release accounting.
- Added provider-neutral object storage with an S3-compatible signed PUT/GET
  adapter. PostgreSQL never stores asset bytes and public contracts never return
  the persisted storage key or provider credentials.
- Upload confirmation verifies actual MIME, byte length, SHA-256 checksum, magic
  bytes, and the malware-scanner verdict before an asset becomes `READY`.
- Draft, restore, and publish operations revalidate all component and inline rich
  text asset references inside their serializable transaction. Deleted,
  non-ready, unauthorized, and cross-tenant references fail closed.
- Apply `20260929120000_north_assets` before starting the new application image.
  Configure S3-compatible storage and an approved scanner adapter before enabling
  uploads. With no scanner adapter the API intentionally returns
  `MALWARE_SCANNER_UNAVAILABLE` and never marks an asset ready.

## NORTH TASK 8C/8D: panel documents and immutable publishing (2026-09-28)

- Added a versioned, validated whole-panel document contract and the exact v1 component catalog.
- Added immutable revisions, coexisting draft/published pointers, preview, autosave, history, restore, and publish APIs.
- Added strong ETag/`If-Match` optimistic concurrency with structured `REVISION_CONFLICT` details.
- Published route resolution now returns only the exact authorized published CONTENT revision; drafts never leak to ordinary readers.
- Asset and binding references fail closed pending their authorized TASK 8E resolvers; no storage provider or scheduler was added.

## Platform administration and organization billing (2026-09-26)

- Added bounded searchable platform indexes/details, explicit delegated ADMIN
  read authority, SUPERADMIN-only suspension/restoration, session revocation,
  and email-only temporary credential pre-provisioning.
- Added provider-neutral organization billing profiles and estimates at USD
  `$14 + $5 × active membership`; groups, pending invitations, suspended users,
  and non-member global operators are not billable.
- Estimates and aggregate totals include only active organizations with a
  non-closed billing profile. Closed profiles and archived or platform-suspended
  organizations retain their configured prices/status for administration but
  report zero billable members and zero estimated total. Aggregate `byStatus`
  remains full inventory and is labeled `ALL_PROFILES`.
- Email-specific invitation responses no longer return raw credentials. This is
  an intentional security tightening; clients accept them from the emailed link.
  Generic CODE invitations still return their code once.
- Apply migrations `20260925120000_platform_administration` and
  `20260926120000_organization_billing` before application startup.
- Dynamic admin/category/content persistence is intentionally deferred pending
  the product specification; decision 013 records only the authority boundary.

## Invitation domain and organization lifecycle (2026-09-24)

- Added single-use email invitations and generic organization join codes with
  expiry, revocation/replacement, keyed hashes, verified-identity enforcement,
  initial group/direct grants, audit, and branded SMTP delivery.
- Added server-normalized organization slugs, reserved route names, owner
  archive/restore lifecycle, inactive-tenant enforcement, and minimal public
  active-organization resolution.
- Compatibility is additive except that organization responses now include a
  required `status` field. Existing invitation creation bodies and active
  legacy invitation tokens remain accepted.
- Apply migration
  `20260924120000_invitation_domain_organization_lifecycle` before starting the
  application image.

## Verified locally

### NORTH Task 8F hardening

- Browser preflight now permits `PUT` and `If-Match`; draft save documents an
  optional initial `If-Match`, while publish and restore require it.
- Reader navigation returns published panels only. Draft metadata remains on
  explicitly authorized management and preview contracts.
- Taxonomy create, move, clone, and template-apply paths enforce configurable
  category/subcategory/panel capacity and reject archived destinations.
  Documents enforce configurable section/component limits (defaults 50/100).
- Taxonomy clone is a transactional deep copy: category and subcategory clones
  recurse into content panels, audience selectors are copied, revision content
  is revalidated, and section/component/list-item identifiers are regenerated.
  Clones remain independent tenant drafts and never retain live source links.
- Compatibility is security-tightening only: clients that previously expected
  draft panels in ordinary navigation must use the authorized management APIs.
  Move request bodies remain additive and unchanged; their strict schemas now
  correctly accept `categoryId`/`subcategoryId`.

The foundation migration applied to an isolated PostgreSQL 16 database. Integration tests exercise actual Better Auth signup, email delivery to a loopback SMTP sink, verification, login, sessions, tenant isolation, role denial, last-owner protection, invitation recipient/replay/revocation/expiry, transactional audit rollback, database audit immutability, API-key scope/ownership/revocation, idempotent contract provisioning, entitlement cancellation, consent, CORS/CSRF, and sign-out.

`pnpm build`, `pnpm lint`, and `pnpm test` are executable checks. `pnpm openapi` generates the checked-in JSON/YAML contract from the same route schemas. CI runs migrations and tests before allowing the deployment job. Provider schemas are available at `/v1/auth/open-api/generate-schema`.

## Before deployment

1. Back up production PostgreSQL and identify the intended operator's existing verified Better Auth credential identity. The removed legacy administrator identifier cannot be used after this release.
2. Set `DATABASE_URL`, a strong `BETTER_AUTH_SECRET`, HTTPS `BETTER_AUTH_URL`, exact `TRUSTED_ORIGINS`, `SMTP_URL`, `SMTP_HELO_NAME`, and `MAIL_FROM` on the backend host. `SMTP_HELO_NAME` must be the public FQDN of the sending host (for example, `api.blackpolar.org`), never an ephemeral Docker hostname. Set `CONTACT_NOTIFICATIONS_ENABLED=true` and the internal `CONTACT_NOTIFICATION_TO` mailbox only on the active API runtime. Google may use Better Auth's canonical `/v1/auth/callback/google` path or the provisioned compatibility callback `/v1/auth/oauth/google/callback`; `GOOGLE_REDIRECT_URL` must exactly match the URI registered with Google. Do not put secrets into either frontend.
3. Run `pnpm db:migrate:deploy` or the verified release workflow. This release scrubs every legacy plaintext administrator identifier, retains the now-empty column for one application rollback window, and adds a nullable admin-secret hash plus the non-null `passwordChangeRequired` flag. Back up first, verify every consumer has moved to `/v1`, and do not edit applied migration SQL. Drop the dormant legacy column only in a later migration after the previous image is retired.
4. Build/start the new API, verify `/v1/live`, `/v1/health`, `/v1/status/summary`, root HTML and a real six-digit email verification flow. Apply `20260922120000_email_verification_codes` and the additive `20260923120000_organization_groups_permissions` migration before starting the new image. The latter adds `BILLING_ADMIN`, organization groups, group membership and group/direct grant tables; composite tenant foreign keys must remain enabled. Signup sends one code; `POST /v1/identity/verification/send` rotates it and `POST /v1/identity/verification/confirm` consumes it. Readiness is degraded if SMTP configuration is missing or the transport connection cannot be verified; successful SMTP verification is still not a recipient-delivery guarantee. Signup returns 503 before mutation while mail settings are missing; the anti-enumerating public resend contract always returns its generic accepted response.
5. Bootstrap or recover the intended operator only if necessary with `pnpm create-admin`. Use its hidden interactive prompts, or inject `CORECROW_BOOTSTRAP_EMAIL`, `CORECROW_ADMIN_SECRET`, and `CORECROW_TEMPORARY_PASSWORD` into that process from the deployment secret manager. Never pass credentials in argv, log them, or save them in a deployment file. The command targets an existing verified identity, creates or rotates its credential account without duplicating the user, marks the password temporary, revokes all sessions, and audits atomically. After sign-in, the operator must call `POST /v1/me/change-temporary-password`; the successful request retains that browser session and revokes every other session.
6. Deploy Mainsite with `NEXT_PUBLIC_CORECROW_URL=https://api.blackpolar.org` (also the default). The public form submits with no auth cookies. Test a controlled contact submission, confirm the internal notification, and inspect the request through the operator API.

The runtime now uses PostgreSQL sessions. Redis remains in Compose only under the `legacy` profile to preserve its existing volume; no Redis data is deleted. The inspected VPS uses the existing `corecrow-api_default` Docker network and database. `scripts/deploy-vps.sh` builds an immutable release, backs up PostgreSQL, applies migrations, checks a candidate on loopback 4101, and runs `corecrow-v1` on loopback 4100. Runtime settings live in root-readable `/etc/blackpolar/corecrow.env`. nginx must target 4100 after initial rollout. The old API on 4000 is preserved during the migration. Future releases keep the previous v1 container for rollback. GitHub Actions bundles the verified commit into a new release directory, without resetting the old server checkout.

## Breaking compatibility removal

All `/api/*` adapters and the legacy administrator identifier flow are removed. The migration scrubs the plaintext legacy values, retains the empty column temporarily for application rollback compatibility, and adds the nullable `adminSecretHash`. Confirm every consumer uses `/v1/*` before deployment. Provision the intended verified identity's new secret with `pnpm create-admin` after applying migrations. Requests to old paths return 404, and `/v1/identity/legacy-migration` no longer exists.

## Email verification compatibility

Verification is no longer link-first. Better Auth remains the canonical identity and credential authority, while CORECROW's public `/v1/identity/verification/send` and `/confirm` contracts provide the browser- and desktop-safe code flow. Clients must stop waiting for or parsing `/v1/auth/verify-email` links. Existing unverified identities can request a code through the new send endpoint; no user-table migration is required. The additive challenge table contains hashes and attempt state only, and can be rolled back by dropping that table after the previous application image is restored.

## Organization authorization compatibility

Organization groups and grant-management routes are additive. The existing
`GET /v1/organizations/{organizationId}/permissions` response shape is stable,
but its result now includes the union of fixed role, group, and direct grants.
Group contracts expose an organization-scoped name and optional nullable
description; both can be updated through the group PATCH contract.
`BILLING_ADMIN` is an additive tenant-role value, so consumers with exhaustive
role handling must be updated before assigning it. `VIEWER` remains supported.
Rollback requires restoring the prior application before dropping the four new
authorization tables; enum values are intentionally not removed during rollback.

## External verification

Local verification does not certify the production environment. No production database migration, payment transaction, SMTP delivery to real recipients, Google OAuth callback, nginx reload, PM2 reload, Docker image build, GitHub workflow run, or deployment has been performed as part of the local test suite. Payment providers, recurring billing and license/seat policy remain outside the implemented contract-provisioning slice.

Database audit triggers require an application DB role that cannot alter schema for strong operational separation; schema-owner credentials can bypass those controls. Configure bounded PostgreSQL connection/statement timeouts. Do not expose the database port publicly.
