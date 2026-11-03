# Organization groups and deterministic permission resolution

- Status: Accepted
- Date: 2026-09-23
- Scope: CORECROW organization authorization

## Decision

Organization access remains anchored in an authoritative membership. The fixed
tenant roles are `OWNER`, `ADMIN`, `BILLING_ADMIN`, `MEMBER`, and the retained
`VIEWER` compatibility role. A user without a membership has no tenant context;
global operator status never bypasses this requirement.

Effective permissions are the deterministic set union of:

1. fixed grants for the membership role;
2. grants from organization groups containing that membership; and
3. direct grants assigned to that membership.

There are no explicit deny grants. Unknown role or permission identifiers are
ignored by resolution and therefore default to deny. Results follow the fixed
permission-registry order, independent of row or insertion order.

Groups have an organization-scoped unique name and an optional editable
description. Groups, group membership, group grants, and direct grants belong
to exactly one organization. Application services validate tenant ownership before mutation,
and composite PostgreSQL foreign keys also reject cross-tenant associations.
Every authorization mutation is audited in the same serializable transaction.

## Compatibility

The migration and routes are additive. The existing effective-permissions
response keeps its `{ role, permissions }` shape, but permissions can now also
come from groups and direct grants. `BILLING_ADMIN` is an additive enum value;
clients with exhaustive role switches must add a case before assigning this
role. `VIEWER` is retained. Invitations remain compatible with the new role but
their lifecycle is not changed by this decision.

There are deliberately no custom permissions, custom roles, explicit denies,
global-admin tenant bypass, organization hierarchy, workspace policy, billing
workflow, or NORTH UI in this slice.

## Amendment (2026-11-02, ADR-0002 option C)

"Global-admin tenant bypass" stays out of scope as a membership shortcut. Platform
operators (SUPERADMIN, `north.organization.manage_all`,
`north.content.manage_all_tenants`) keep content access to tenants, but a write to
an organization they are not a member of is audited as `PLATFORM_OPERATOR_WRITE`
in that tenant's audit log, with the capability and a reason sent in
`X-Platform-Reason` (10+ characters, required when
`PLATFORM_OPERATOR_REASON_REQUIRED=true`). Reads, members and global
capabilities are unchanged. NORTH asks the operator for the reason once.
