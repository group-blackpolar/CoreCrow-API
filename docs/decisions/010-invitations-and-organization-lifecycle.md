# Invitation domain and organization lifecycle

- Status: Accepted
- Date: 2026-09-24
- Scope: CORECROW tenancy

## Decision

Organizations are created only through the authenticated CORECROW API. The
creator becomes `OWNER` in the same serializable transaction and no billing
record is implied. Slugs are normalized by CORECROW to lowercase URL-safe ASCII,
stored in canonical form, and protected by a database unique constraint. A
conservative reserved set covers NORTH and CORECROW platform route names.

Owners can archive and restore their organizations. `SUSPENDED` is reserved for
the platform-administration domain. Inactive organizations remain visible to
their members but tenant operations other than organization read/lifecycle are
denied. Public slug resolution returns only the name and canonical slug of an
active organization; it does not expose identifiers, membership, billing, or
configuration.

Invitations are either email-specific or generic codes. Both are single-use,
expire, can be revoked or replaced, and store only a keyed credential hash for
new records. Acceptance always requires an authenticated verified identity;
email invitations additionally require the authoritative normalized email to
match. Invitation state is pending access and never marks an email verified.

An invitation can carry a fixed tenant role, initial organization-group
assignments, and registered direct permission grants. CORECROW validates every
group against the invitation tenant, database composite foreign keys enforce
the same boundary, and acceptance applies membership and grants atomically.
Email-specific invitations use the configured identity mail transport and
return delivery status without exposing credentials in API responses. Generic
codes return their raw credential once to the authorized issuer. No invitation
credential is returned by later list operations.

## Compatibility

Existing `POST /v1/organizations/:organizationId/invitations` requests with
`email` and optional `role` remain valid. As an intentional security tightening,
email-invitation responses no longer return `token`; the credential exists only
in the delivered link. Generic `CODE` invitations still return the code once.
Existing 64-character invitation tokens are accepted through a legacy-hash
lookup until consumed or expired. Organization responses add `status`.

Organization creation now accepts an optional slug and canonicalizes supplied
values. Clients that relied on rejecting uppercase or accented slug input will
instead receive the canonical slug. `PATCH /v1/organizations/:id` remains
compatible with name-only requests and additionally accepts slug changes.

Temporary-password pre-provisioning is deliberately not part of invitation
issuance: an invitation must not create or take ownership of a global identity.
Credential recovery remains in the identity domain.
