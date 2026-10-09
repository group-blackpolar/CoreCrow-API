# Object storage sourcing, ClamAV pinning and on-host backups

- Status: Accepted (applied to the Contabo VPS on 2026-10-09)
- Scope: CORECROW infrastructure for ADR-015, ADR-022 and the dataset-import stack

## Context

CORECROW needs a private, versioned, S3-compatible store (assets, avatars, dataset imports) and a clamd scanner. On 2026-10-09:

- `quay.io/minio/minio` returns "no such manifest", Docker Hub denies `minio/minio`, and `github.com/minio/minio` is archived. The final
  release notes (`RELEASE.2025-10-15T17-29-55Z`, which fixes a service-account privilege-escalation CVE) tell container users to build from source.
- ClamAV publishes `clamav/clamav` on Docker Hub. `1.5.4-debian` resolves to the multi-arch index digest
  `sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578`, identical from the Docker Hub API and from the VPS registry client.

## Decision

- **MinIO and `mc`** are built on the VPS from the official source tags by `deploy/minio-from-source/Dockerfile` (`scripts/build-minio-images.sh`).
  The build verifies the checked-out commit against the pinned SHA (MinIO `9e49d5e7a648…`, `mc` `7394ce0dd2a8…`), and both the Go builder and the
  Debian runtime are official library images pinned by digest. The resulting local image IDs are pinned in `/etc/blackpolar/corecrow-dataset.env`
  (provisioning accepts `sha256:<id>` for locally built images and still requires a digest for registry images). The server runs as uid 10001.
- **ClamAV** uses the pinned official image and `CLAMD_CONF_*` environment settings (verified effective in the running container):
  `StreamMaxLength`/`MaxFileSize` 256M, `MaxScanSize` 512M, `AlertExceedsMax yes`.
- **No public ports.** clamd (3310) and the MinIO console (9001) live only on the private `corecrow-api_default` Docker network; the MinIO API is
  published on `127.0.0.1:9000` solely for the nginx proxy below. CPU, memory and PID limits and `no-new-privileges` are set in the compose file.
- **Versioning everywhere.** Both buckets are versioned. Assets and avatars are pinned to the scanned VersionId; CoreCrow purges every version of a
  deleted or rejected object (policy: `DeleteObjectVersion` on the asset prefixes). No lifecycle expiry is configured, because one could delete the
  pinned version of a live object after an overwrite.
- **Backups.** `scripts/backup-vps.sh` (systemd timer `corecrow-backup.timer`, daily) takes a verified `pg_dump -Fc` (14-day retention, SHA-256
  manifest) and mirrors both buckets into a private directory. A restore of the latest dump into a scratch database was verified.

## Browser access to presigned URLs

Presigned URLs must be reachable by browsers, so they are signed for `https://api.blackpolar.org` (`NORTH_ASSET_S3_PUBLIC_ENDPOINT`,
`NORTH_DATA_IMPORT_S3_PUBLIC_ENDPOINT`; presigning is local, server-side calls keep the private endpoint). nginx on the API host proxies
only presigned `GET`/`PUT`/`HEAD` for `/corecrow-assets/{north-assets,user-avatars}/` and `/corecrow-dataset-imports/north-data-imports/` to MinIO,
which is published on `127.0.0.1:9000` only. The path and `Host` are forwarded untouched because the signature covers them. Requests without
`X-Amz-Signature`, other prefixes (bucket listings included) and other methods are refused by nginx, and CORS allows `https://north.blackpolar.org`
only (`deploy/nginx/*`). No new DNS record or certificate is needed. `api.blackpolar.org` is behind Cloudflare, whose request-body cap
(100 MB on the free plan) therefore bounds uploads: `NORTH_ASSET_VIDEO_MAX_BYTES` is set below it. The asset probe exercises this public path
(unsigned and off-prefix refusals, a browser-style presigned PUT, a pinned presigned GET, CORS).

## Consequences and debt

- MinIO community is unmaintained: no further security fixes. Plan a migration (a maintained S3 store with versioning and checksum-bound presigned PUT)
  before storing sensitive production data at scale. The application only needs the S3 API, so the swap is operational.
- The backups are on the same host. An off-host copy needs a destination and credentials chosen by the owner; until then a host loss loses both data and
  backups. This is not yet done.
- `Organization_iconAssetId_id_fkey` is a hand-maintained composite foreign key (not a Prisma relation; see the schema comment).
