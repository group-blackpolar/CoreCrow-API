# User avatars and organization icon assets

- Status: Proposed (code and migration are in the PR; nothing is applied or deployed)
- Date: 2026-10-08
- Scope: CORECROW identity, tenancy and NORTH assets (builds on ADR-015)

## Audit

- `User` has no usable picture field. `User.image` exists but is unused and untyped.
- `Organization.iconData` holds a validated data URL (<= 256 KB, <= 512x512). It works today.
- `NorthAsset` is organization-scoped (`organizationId` required, quota-charged, `north.asset.*` capabilities).
  `@@unique([id, organizationId])` makes a tenant-safe composite reference possible.
- In the default wiring the malware scanner is `UnconfiguredMalwareScanner` and object storage is
  `UnavailableObjectStorage` unless `NORTH_ASSET_S3_*` is set. **No asset can become READY until both are configured**
  (a scanner adapter does not exist yet). This gates the whole feature in production.

## Decision

**Organization icon.** Add `Organization.iconAssetId` with a composite FK `(iconAssetId, id) -> NorthAsset(id, organizationId)`,
`ON DELETE RESTRICT`, so a cross-tenant reference is impossible even outside the service. `PATCH /organizations/:id` accepts
`iconAssetId` (requires `organization.update`, plus `north.asset.read`; the asset must be READY, live, JPEG/PNG/WebP, <= 1 MiB).
`GET /organizations/:id/icon` returns a short-lived signed read for any member who can read the organization (the icon is identity
data, so `north.asset.read` is not required). Deleting an asset that is the current icon fails with `ASSET_IN_USE`.
`iconData` is **kept** as the fallback and as the source of the progressive conversion; the last write wins (a legacy data URL
clears `iconAssetId`, an asset does not touch `iconData`). Dropping `iconData` is a later migration after verification.

**User avatar.** A person is not an organization, so avatars do not reuse `NorthAsset`. New `UserAvatar` (user-scoped, no quota)
reuses the same storage adapter, scanner interface and byte-level validation (`validateInspectedAsset`). Routes live under
`/me/avatar` and carry no user id, so there is no object to forge: upload request, confirm, signed read, delete. JPEG/PNG/WebP,
<= 2 MiB. A partial unique index allows at most one READY, non-deleted avatar per user; confirming a new one retires the old one in
the same transaction and deletes the old object after commit. Abandoned uploads are swept on the next upload request.
Visibility is **private to the owner**; showing a person's picture to other members needs a separate decision (same-organization
membership rule) and is out of scope.

## Failure handling

Object deletion always runs after the database commit: a storage failure leaves an unreferenced object, never a dangling
reference. Storage or scanner unavailability fails closed (503) and leaves the upload retryable. Rejected or quarantined avatars are
deleted from storage. Deleting a user cascades the avatar rows; their objects need the same orphan sweep as other assets.

## Compatibility and rollout

Additive migration `20261008120000_media_assets_avatars_icons`; no row is rewritten. Existing icons keep working through
`iconData`. NORTH uses the managed path first and falls back to `iconData` for icons when CORECROW cannot store assets. Avatars have
no legacy path and report "storage not available" until storage and a scanner adapter are configured.

## Pending

- A production malware-scanner adapter and `NORTH_ASSET_S3_*` configuration (blocker for enabling the feature).
- Bulk conversion of existing `iconData` to assets (needs the scanner; dry-run by default when written).
- Orphan sweep for objects whose rows were cascaded or whose deletion failed.
