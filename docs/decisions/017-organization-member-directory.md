# Organization member directory response

- Status: Accepted
- Date: 2026-10-05
- Scope: CORECROW organization membership API

## Decision

`GET /v1/organizations/:organizationId/members` keeps its existing
membership-derived `members.read` authorization and adds the minimum global
identity attributes needed to administer that tenant: normalized email, optional
name, and account status. The membership identifier, user identifier, tenant
role, organization identifier, and membership creation time remain present.

The repository selects these identity attributes explicitly through the
membership relation. The response does not expose global operator role, email
verification state, password-change state, terms state, image, credential
material, administrative secrets, sessions, or account-provider records.
Callers without an authoritative membership continue to receive the existing
default-deny not-found response, including global operators without tenant
membership.

## Compatibility

The change is additive: existing member fields and authorization semantics are
unchanged. JSON consumers that ignore unknown fields continue to work. Consumers
that validate closed response objects must accept `email`, `name`, and `status`
before adopting this contract version. Role changes, removal, last-owner
protection, group grants, permission grants, and their transactional audit
behavior are unchanged.
