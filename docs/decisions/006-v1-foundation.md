# v1 foundation implementation decisions

Date: 2026-09-13. Scope: this Mainsite/CoreCrow rework. This records the choices implemented here; it does not imply prior approval of the workspace's open architecture decisions.

## Identity and compatibility

Better Auth owns all human authentication, including operators, under `/v1/auth`. PostgreSQL stores sessions; Redis and cookie caches no longer delay revocation. Sessions expire after 12 hours without refresh. Email/password accounts require verified email and a 12-character minimum password. SMTP handles verification and recovery. Google is enabled only when configured.

`/api/auth/*` rewrites to the same provider handler; new callbacks and links use `/v1/auth`. Provider `Set-Cookie` headers remain separate. Existing cookies without database sessions require a fresh login. Legacy login is disabled by default. An explicit `ENABLE_LEGACY_ADMIN_AUTH=true` enables a temporary bridge for existing verified ADMIN/SUPERADMIN identities: email plus the existing identifier yields an audited, one-hour session. `/v1/identity/legacy-migration` enrolls a password, permanently clears the identifier and revokes all old sessions in one transaction. Legacy sessions work only on compatibility adapters and enrollment, never the general v1 API. Init/exists/users discovery remain 410. Existing `/api/users`, `/api/admin/keys`, and `/api/admin/logs` adapters accept Better Auth operator sessions or the opt-in legacy session. No automatic elevation occurs.

Provision the first SUPERADMIN by registering/verifying an identity, then running `pnpm create-admin` on the trusted backend host. This one-time transaction revokes that user's old sessions and appends an audit record. Later global role changes require an authenticated SUPERADMIN and cannot target the actor's own role.

## Tenancy and policy

Organizations have OWNER, ADMIN, MEMBER, VIEWER memberships. Permissions are a fixed, default-deny registry. Global operators do not bypass tenant reads. Owners can manage roles; tenant admins can manage only MEMBER/VIEWER targets. Serializable transactions and retries protect the last-owner invariant and invitation consumption. A matching verified email is required to accept an unexpired, unrevoked, single-use invitation. Tokens are returned once for secure sharing; automatic invitation email is not implemented.

Existing identifiers remain opaque strings; new Prisma entities retain CUID defaults. Personal-context product semantics, hierarchy, custom roles and PostgreSQL RLS are not introduced.

## Commerce

Products/plans, contract subscriptions, open invoices, and explicit time-limited entitlements form a working shared commerce slice. Only SUPERADMIN can provision an approved contract. The API does not collect payment. Exact integer minor units and currency codes represent amounts. An idempotency key binds a provisioning request to a normalized payload. Cancellation revokes entitlements transactionally. Expired rights are excluded on every resolution.

No payment provider, checkout, payment webhook, automated recurring billing, purchase ledger, seat-license enforcement, or individual billing model is implied. Those still need product/provider decisions. An open invoice does not grant access: the operator's audited contract provisioning explicitly grants entitlements.

## Audit and security

Application mutations append audit events in the same transaction. Better Auth lifecycle hooks record identity/session/account events; those provider lifecycle callbacks are not claimed to form a shared atomic transaction with our audit repository. Denials and rate-limit events are recorded after the response; failure is logged without request secrets. PostgreSQL triggers reject audit UPDATE, DELETE, and TRUNCATE. A privileged database owner can override triggers during controlled maintenance; this is not a tamper-proof external ledger.

API keys are hashed, valid for seven days, returned once, and immediately revocable. They allow only explicitly scoped tenant/commerce reads. Current user existence, verified email and current membership remain authoritative. Global administrative and write endpoints reject keys.

Writes with cookies require an allowed Origin. CORS and Better Auth share the configured origin list. Proxy headers are trusted only when explicitly configured; rate limiting is per process, so multi-instance distributed limits remain an operational consideration. No product implementation or additional production service has been introduced.
