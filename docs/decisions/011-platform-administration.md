# Platform administration authority

- Status: Accepted
- Date: 2026-09-25
- Scope: CORECROW platform administration

## Decision

Platform administration uses explicit `/v1/platform/...` contracts and never
changes the membership requirement of tenant resource APIs. `ADMIN` and
`SUPERADMIN` can read bounded, searchable user and organization indexes and
non-secret detail. Only `SUPERADMIN` can suspend or restore identities and
organizations or change organization billing status.

Identity suspension revokes every session in the same serializable transaction.
All principal transports re-read authoritative user status and deny suspended
identities. Organization suspension is likewise default-deny in tenant
authorization; only the explicit platform administration contract can restore
it. Operator status does not grant membership or tenant resource access.

Operators may pre-provision `USER` and `DEVELOPER` identities; creating an
`ADMIN` requires `SUPERADMIN`. CORECROW generates a temporary credential,
stores only its password-grade hash, marks password replacement required, and
sends the raw value only through configured identity mail. The API never returns
the raw credential. The recipient must verify the authoritative email before
sign-in and replace the temporary password before other protected operations.

## Compatibility

The platform routes and account status field are additive. Suspending an
identity intentionally invalidates existing sessions. Suspended identities and
organizations that previously had access now receive stable denial errors.
