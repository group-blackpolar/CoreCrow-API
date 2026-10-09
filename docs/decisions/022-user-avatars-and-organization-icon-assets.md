# User avatars and organization icon assets

- Status: Accepted implementation record (integrated locally; nothing is applied or deployed)
- Date: 2026-10-08
- Scope: CORECROW identity, tenancy and NORTH assets (builds on ADR-015)

## Audit

- `User` has no usable picture field. `User.image` exists but is unused and untyped.
- `Organization.iconData` holds a validated data URL (<= 256 KB, <= 512x512). It works today.
- `NorthAsset` is organization-scoped (`organizationId` required, quota-charged, `north.asset.*` capabilities).
  `@@unique([id, organizationId])` makes a tenant-safe composite reference possible.
- Wiring: object storage is `UnavailableObjectStorage` unless `NORTH_ASSET_S3_*` is set, and the scanner is built by
  `malwareScannerFromEnvironment`: the shared ClamAV adapter when a `CORECROW_CLAMAV_*` endpoint is configured, otherwise
  `UnconfiguredMalwareScanner`, which fails closed with 503. **An asset or avatar becomes READY only when both a private
  versioned bucket and a reachable clamd are configured**; either missing gate leaves uploads retryable and nothing served.

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
no legacy path and report "storage not available" until the private bucket and clamd are configured and the release probe passes.

Integration note (2026-10-08): this change is additive alongside the CoreCrow AI MVP and the dataset-import VPS stack. It does
not alter AI contracts or tenant authorization. Dataset imports and ordinary assets keep separate scanner interfaces and storage
policies, but share a bounded, fail-closed ClamAV INSTREAM transport and private clamd endpoint. Asset and avatar confirmation is
enabled only when its separate object-storage bucket and ClamAV configuration are both present and the release probe succeeds.

## Shared scanner and exact-version reads

`src/infrastructure/clamav.ts` is the single clamd transport for dataset imports, `NorthAsset` and `UserAvatar` (organization icons are
`NorthAsset`s). It streams the private object through `zINSTREAM` with backpressure, an idle timeout, a wall-clock deadline, caller abort,
explicit byte limits and a strict reply parser (`stream: OK` and `stream: <signature> FOUND` are the only accepted answers; clamd `ERROR`,
garbage, truncated or oversized replies are "unavailable"). Configuration is common: `CORECROW_CLAMAV_SOCKET` or `_HOST`/`_PORT`,
`_TIMEOUT_MS`, `_DEADLINE_MS`, `_MAX_BYTES` (can only lower a caller's ceiling) and `_CHUNK_BYTES`; the legacy
`NORTH_DATA_IMPORT_CLAMAV_*` endpoint variables are still read. Nothing publishes a clamd port to the host, and nothing logs keys, bytes or
credentials. Infected content is `QUARANTINED`; unavailability, timeouts and oversize never become an approval.

Confirmation records the exact provider `VersionId` it inspected and scanned (`storageVersionId`, additive migration
`20261008140000_asset_storage_versions`, required for READY rows by a CHECK). The scanner reads that version and every signed GET is pinned to
it, so bytes written later to the same key (for example through a still-valid signed PUT) are never served. A bucket without versioning
fails confirmation with `ASSET_STORAGE_IMMUTABILITY_UNAVAILABLE` (503, retryable). clamd must allow the largest scanned object
(`StreamMaxLength`/`MaxFileSize` 256M, `AlertExceedsMax yes` so an over-limit file is an alert, not a silent OK); the compose file sets this.
`scripts/verify-asset-infrastructure.mjs` proves versioned private storage, pinned inspection and reads, a clean verdict and an EICAR
quarantine, then removes every probe version; it is independent of the import probe and runs in `scripts/deploy-vps.sh`.

## Pending

- Production `NORTH_ASSET_S3_*` credentials and successful storage/ClamAV probe on the target VPS.
- Bulk conversion of existing `iconData` to assets (needs the scanner; dry-run by default when written).
- Orphan sweep for objects whose rows were cascaded or whose deletion failed.
