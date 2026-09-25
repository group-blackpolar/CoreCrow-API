# NORTH global templates, authorized search, and audit correlation

- Status: Accepted
- Date: 2026-09-30
- Scope: CORECROW NORTH contracts

## Decision

Global NORTH templates are immutable versioned snapshots managed only by an
active `SUPERADMIN`, or by an active platform `ADMIN` with
`north.template.manage_global`. Organization actors require
`north.template.read` to inspect a template and `north.template.apply` to apply
one. Applying a version creates new tenant-owned category, subcategory, panel,
section, component, and revision identifiers. The copied category records the
source template and version, but no live relationship can mutate the copy.
PostgreSQL rejects update, delete, and truncate operations on stored template
versions so append-only history is enforced below the application service.
Copied documents begin as drafts and require ordinary tenant publication; demo
or template content never becomes production content automatically.

Template snapshots cannot contain tenant-bound group or membership audiences.
Asset and dynamic-binding references fail closed during template validation,
because no portable authoritative mapping exists in TASK 8.

Organization search is tenant-scoped before matching and re-authorizes each
result. Published panels additionally require current audience access; draft
matching requires `north.panel.preview`. Search returns metadata only and never
returns a draft document or unauthorized existence signal. The initial bounded
implementation searches localized taxonomy metadata, exact authorized panel
revision text, and READY asset filename/MIME metadata.

HTTP contract execution carries Fastify's request identifier through an
asynchronous request context. Audit append operations persist that identifier
when present. Background or command-originated events may have a null request
identifier because there is no HTTP request to correlate.

## Compatibility

The template, search, and audit-request fields are additive. Tenant category
creation now accepts only `CUSTOM`; platform templates use the dedicated global
template contract. Applied templates are drafts, so clients must explicitly
publish them. Existing generic `audit.read` grants remain accepted by the
organization audit route, while the new `north.audit.read` capability is also
supported for scoped NORTH authorization.

Ordinary navigation is intentionally a published-reader contract and never
reveals draft panel metadata, including to editors. Draft inventory and preview
remain explicit management operations. Taxonomy cloning is copy semantics, not
link semantics: it recursively creates tenant-owned metadata, audiences and a
new validated draft revision with regenerated document identifiers. Capacity
limits and active-parent checks execute inside the same transaction, so a
failed clone, move, or template application leaves no partial hierarchy.
