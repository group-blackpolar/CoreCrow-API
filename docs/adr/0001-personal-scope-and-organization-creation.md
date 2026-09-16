# ADR 0001: Personal scope and explicit organization creation

- Status: Accepted
- Date: 2026-09-16

## Decision

Every verified Black Polar identity has a personal scope even when it has no
organization membership. A personal scope is not represented as a synthetic
organization.

Organization creation remains an explicit authenticated action. Registration
does not create an organization automatically. Joining an existing organization
requires a verified matching identity and a valid single-use invitation.

The future NORTH workspace model may contain personal and organization-owned
resources, but CORECROW remains the exclusive persistence and authorization
boundary. The workspace data model and contracts are intentionally deferred to
the NORTH application architecture phase.

## Consequences

- Users without invitations can enter NORTH in personal scope.
- Tenant roles and billing never leak into personal scope.
- Organization creation is auditable and produces an `OWNER` membership.
- No hidden or placeholder tenant is required during onboarding.
