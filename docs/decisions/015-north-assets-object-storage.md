# NORTH assets, object storage, and quota reservation

- Status: Accepted
- Date: 2026-09-29
- Scope: CORECROW NORTH assets

## Decision

Asset bytes live in provider-neutral object storage; PostgreSQL stores only
tenant-scoped metadata. The initial adapter targets the maintained AWS S3 API
and supports S3-compatible endpoints. Provider credentials remain in the
backend credential chain. Public responses expose asset metadata and
short-lived signed operations, never the persisted storage key.

An upload reserves organization quota inside a serializable transaction before
it is accepted. `storageUsedBytes`, `storageReservedBytes`, and
`storageLimitBytes` are database-enforced non-negative counters whose sum may
not exceed the limit. Confirmation inspects actual MIME, size, SHA-256 checksum,
and magic bytes, then invokes the configured malware-scanner boundary. Only an
approved object becomes `READY`; rejected or quarantined objects release their
reservation. Scanner or storage unavailability fails closed.

The initial allowlist is JPEG, PNG, GIF, WebP, PDF, MP4, and WebM. Limits are
centrally configured by class with 10 MiB image, 50 MiB document, and 250 MiB
video defaults. They are technical controls, not product billing limits.

Every signed read re-authorizes `north.asset.read`. Create, read, and delete use
the exact `north.asset.*` capabilities and authoritative membership-derived
tenant context. Non-ready, deleted, unauthorized, or cross-tenant assets are
not readable or referenceable. Panel draft, restore, and publish validation all
re-check ready same-tenant references.

Deletion is logical and quota-releasing in the same transaction as its audit
event, followed by a provider deletion request. If the provider is unavailable,
the row remains inaccessible and a retry can complete physical deletion.

## Compatibility

The schema, routes, environment settings, and migration are additive. Existing
organizations receive a generous 10 GiB technical limit and zero usage. No
existing panel contract changes shape, but asset-bearing documents that could
previously only fail with `ASSET_VALIDATION_UNAVAILABLE` now require a `READY`
asset and actor `north.asset.read` authority. No real malware scanner is claimed
until an infrastructure adapter is explicitly configured.
