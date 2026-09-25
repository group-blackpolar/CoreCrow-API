# v1 foundation implementation decisions

Identity amendment (2026-09-21): the explicit permanent-admin-secret and
`/api/*` removal decision below supersedes the original temporary compatibility
bridge for this implementation.

Tenancy amendment (2026-09-24): decision 010 supersedes the original
email-only invitation lifecycle described below. Invitations now include
email delivery and generic single-use codes while retaining acceptance of
unexpired legacy tokens.

Date: 2026-09-13. Scope: this Mainsite/CoreCrow rework. This records the choices implemented here; it does not imply prior approval of the workspace's open architecture decisions.

## Identity and compatibility

Better Auth owns all human authentication, including operators, under `/v1/auth`. PostgreSQL stores sessions; Redis and cookie caches no longer delay revocation. Sessions expire after 12 hours without refresh. Email/password accounts require verified email and a 12-character minimum password. Signup and resend deliver a six-digit verification code through SMTP rather than a browser link. CORECROW stores only a keyed code hash, expires it after 10 minutes, replaces it on resend, limits it to five attempts, and consumes it transactionally with the Better Auth user verification update and audit record. The public send response is anti-enumerating. Google is enabled only when configured.

Better Auth owns normal human authentication under `/v1/auth`. Provider `Set-Cookie` headers remain separate. Existing cookies without database sessions require a fresh login. The unversioned `/api/*` compatibility routes, legacy administrator identifier, migration endpoint, feature flag, and bearer sessions were intentionally removed on 2026-09-21. This is a breaking change: clients must use `/v1/*` and old paths now return the standard 404 contract.

Operators may additionally authenticate at `POST /v1/admin/sign-in` with their normalized email and permanent admin secret. Only a password-grade salted hash is stored. Verification performs password-grade work for unknown identities, failures are generic and rate limited, and success creates the standard 12-hour Better Auth session through an HttpOnly cookie without returning a bearer token. The identity must be verified and currently have an ADMIN or SUPERADMIN role.

Provision or recover the intended SUPERADMIN by registering/verifying a Better Auth identity, then running `pnpm create-admin` on the trusted backend host. The command takes the permanent admin secret and temporary account password through hidden interactive input or runtime-only process environment values. It targets the unique normalized email, creates or rotates exactly one credential account without duplicating the user, password-grade hashes both credentials, marks the account password as requiring change, revokes all sessions, and audits in the same transaction. Re-running it for the current superadmin safely rotates/repairs both credentials. The operator must replace the temporary password through `POST /v1/me/change-temporary-password`; until then, protected operations other than `/v1/me` are denied. The change verifies the current password, retains only the current browser session, clears the flag, and audits atomically. Later global role changes require an authenticated SUPERADMIN and cannot target the actor's own role.

## Tenancy and policy

Organizations have OWNER, ADMIN, BILLING_ADMIN, MEMBER, and retained VIEWER memberships. Permissions are a fixed, default-deny registry. Effective access is the deterministic union of base-role, organization-group, and direct membership grants as recorded in decision 009. Global operators do not bypass tenant reads. Owners can manage roles; tenant admins can manage only BILLING_ADMIN/MEMBER/VIEWER targets. Serializable transactions and retries protect the last-owner invariant and invitation consumption. A matching verified email is required to accept an unexpired, unrevoked, single-use invitation. Tokens are returned once for secure sharing; automatic invitation email is not implemented.

Existing identifiers remain opaque strings; new Prisma entities retain CUID defaults. Personal-context product semantics, hierarchy, custom roles and PostgreSQL RLS are not introduced.

## Commerce

Products/plans, contract subscriptions, open invoices, and explicit time-limited entitlements form a working shared commerce slice. Only SUPERADMIN can provision an approved contract. The API does not collect payment. Exact integer minor units and currency codes represent amounts. An idempotency key binds a provisioning request to a normalized payload. Cancellation revokes entitlements transactionally. Expired rights are excluded on every resolution.

No payment provider, checkout, payment webhook, automated recurring billing, purchase ledger, seat-license enforcement, or individual billing model is implied. Those still need product/provider decisions. An open invoice does not grant access: the operator's audited contract provisioning explicitly grants entitlements.

## Audit and security

Application mutations append audit events in the same transaction. Better Auth lifecycle hooks record identity/session/account events; those provider lifecycle callbacks are not claimed to form a shared atomic transaction with our audit repository. Denials and rate-limit events are recorded after the response; failure is logged without request secrets. PostgreSQL triggers reject audit UPDATE, DELETE, and TRUNCATE. A privileged database owner can override triggers during controlled maintenance; this is not a tamper-proof external ledger.

API keys are hashed, valid for seven days, returned once, and immediately revocable. They allow only explicitly scoped tenant/commerce reads. Current user existence, verified email and current membership remain authoritative. Global administrative and write endpoints reject keys.

Writes with cookies require an allowed Origin. CORS and Better Auth share the configured origin list. Proxy headers are trusted only when explicitly configured; rate limiting is per process, so multi-instance distributed limits remain an operational consideration. No product implementation or additional production service has been introduced.
