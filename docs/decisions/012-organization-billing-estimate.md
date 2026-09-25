# Provider-neutral organization billing estimate

- Status: Accepted
- Date: 2026-09-26
- Scope: CORECROW billing

## Decision

Every organization has one provider-neutral billing profile initialized in the
same transaction as normal organization creation. Existing organizations are
backfilled by the additive migration. The current USD monthly estimate is
deterministic:

```text
$14.00 organization base + $5.00 × active billable memberships
```

Amounts are integer minor units: `1400` and `500`. A billable membership is an
existing organization membership whose global identity is active. Pending
invitations, deleted memberships, suspended identities, global operators without
membership, and organization groups do not add seats. Groups always cost zero.

An estimate is eligible only while the organization status is `ACTIVE` and the
billing profile is not `CLOSED`. `ACTIVE`, `PAST_DUE`, and billing `SUSPENDED`
profiles remain estimate-bearing commercial states until a later collection
policy supersedes this decision. `CLOSED` is terminated and non-billable.
Archived or platform-suspended organizations are also non-billable. Per-profile
views retain configured prices and statuses but report zero seats and zero total
while ineligible.

`billing.read` and `billing.manage` are fixed tenant permissions. Owners and
tenant admins receive both; `BILLING_ADMIN` receives both; ordinary members and
viewers receive neither. Tenant billing managers can maintain the billing email.
Only `SUPERADMIN` changes billing status. Platform operators can read aggregate
counts and estimates through explicit platform contracts.

Platform aggregate `organizationCount`, `billableMemberCount`, and
`estimatedMonthlyMinor` include only estimate-eligible profiles. `byStatus` is
deliberately the full billing-profile inventory for administrative visibility;
the response identifies this with `byStatusScope: "ALL_PROFILES"`.

This model does not charge money, call a provider, create invoices, or grant
entitlements. The existing commerce contracts remain independent.

## Compatibility

Billing routes, permissions, profile tables, and response fields are additive.
Clients with exhaustive permission switches must add `billing.read` and
`billing.manage`. The migration must precede application startup because normal
organization creation now initializes the profile atomically.
