# 012 — Security and access

Status: implemented on `feat/security-access` (not deployed). Date: 2026-10-20.

## Decisions

1. **Per-organization policy, off by default.** `organization_security_policies`: no row = nothing tracked or enforced (existing users unaffected). A row turns on tracking (devices/sessions tagged with the governing organization); `enforcement=true` turns on the limits.
2. **Devices and sessions are limited independently.** `maxDevices` and `maxSessions`. Overflow policy: `BLOCK_NEW` (initial/recommended), `REPLACE_OLDEST` (ends older *sessions* only), `REQUIRE_USER_CHOICE` (409; the user ends another session via `DELETE /v1/me/sessions/{id}`). Devices are never deleted automatically; only a person with `security.devices.revoke` revokes one.
3. **Governing organization.** Accounts created by an organization (`users.createdByOrganizationId`, see PR "organization-created accounts") are governed by that organization. Other users are tracked under the first organization (by id) with a policy and limited by the strictest enforcing policy among their organizations.
4. **Decision point.** `modules/security-access/enforcement.ts#admitSession` runs right after a session row exists (Better Auth `session.create.after`, and desktop exchange). It takes `pg_advisory_xact_lock` per user, so concurrent sign-ins cannot exceed the cap; a refused sign-in deletes its session and the auth route replaces the response with the error (no session cookie is delivered). An unexpected error in admission fails *open* (logged) so a bug cannot lock everyone out; explicit denials are final.
5. **Device identity.** Opaque random cookie `bp_device` (HttpOnly, 1 year), stored as SHA-256. No browser fingerprinting. Desktop (Bearer) sign-ins register no device (session limits and IP rules still apply). One cookie per browser: several accounts on one browser register extra devices.
6. **IP rules.** `security_ip_rules` (ALLOW/DENY; IPv4, IPv6, CIDR; `::ffff:a.b.c.d` normalized). Deny wins; with at least one ALLOW the address must match one; no rules = open. Evaluated wherever membership is resolved (`resolvePermissions`) and at sign-in for organization-created accounts. A rule that would block the caller's own address is refused (`WOULD_LOCK_OUT`).
7. **Trusted proxies.** `TRUST_PROXY` now accepts `loopback`, an address, or a comma list of addresses/CIDRs (invalid entries are dropped; nothing invalid is trusted). `X-Forwarded-For` is honored only from those proxies; otherwise the socket address is used.
8. **Permissions.** Thirteen `security.*` permissions. OWNER holds all; ADMIN, BILLING_ADMIN, MEMBER, VIEWER hold none by default (no automatic grant to existing roles). They can only be granted to a *person* (direct grant), never to a group (group grants of `security.*` are rejected and ignored), and only by someone who holds them (`PRIVILEGE_ESCALATION` otherwise). The "Users and authentication" view is served under `security.sessions.view`.
9. **Alerts.** `security_alerts`, deduplicated per organization/kind/user/hour (`count` grows). E-mail only when enabled (`security.notifications.manage`), once per alert, recipients explicit or the organization's owners that have a real mailbox; delivery failure is recorded on the alert and never fails the request.
10. **Retention.** Default 90 days (7–3650) for operational records of the policy: non-open alerts, revoked devices and the retention log. Not touched: active devices, sessions, the general audit log. Hourly sweep (`SECURITY_RETENTION_ENABLED=false` disables), advisory-locked and idempotent; an authorized exception (`retentionExemptUntil` + reason + author, requires `security.policies.manage`) skips the organization. Each run is recorded in `security_retention_runs` and audited; the overview shows the last result.

## Routes

`/v1/organizations/{organizationId}/security/{overview,devices,devices/{id},sessions,sessions/{id},users,users/{id}/sessions,ips,ips/{id},policy,notifications,alerts,alerts/{id},audit}` and `/v1/me/sessions`.

## Rollout and rollback

Migration `20261020150000_security_access` is additive (five tables, four enums, two nullable `sessions` columns). Behavior changes only for an organization that saves a policy. Rollback: stop using the feature (delete the policy row restores the previous behavior), or drop the objects listed in the migration header. `TRUST_PROXY` semantics are backward compatible with the previous `loopback`/single-address values.

## Known limits

Sessions of a multi-organization user are attributed to one governing organization; a shared browser registers one device per account; the device-limit and session-limit checks happen after the session row is created (the row is removed before the cookie leaves the server); rate limiting remains in-memory per instance.
