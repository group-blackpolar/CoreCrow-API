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
- **Nothing is published to the host.** MinIO (9000/9001) and clamd (3310) live only on the private `corecrow-api_default` Docker network; CPU, memory
  and PID limits and `no-new-privileges` are set in the compose file.
- **Versioning everywhere.** Both buckets are versioned. Assets and avatars are pinned to the scanned VersionId; CoreCrow purges every version of a
  deleted or rejected object (policy: `DeleteObjectVersion` on the asset prefixes). No lifecycle expiry is configured, because one could delete the
  pinned version of a live object after an overwrite.
- **Backups.** `scripts/backup-vps.sh` (systemd timer `corecrow-backup.timer`, daily) takes a verified `pg_dump -Fc` (14-day retention, SHA-256
  manifest) and mirrors both buckets into a private directory. A restore of the latest dump into a scratch database was verified.

## Consequences and debt

- MinIO community is unmaintained: no further security fixes. Plan a migration (a maintained S3 store with versioning and checksum-bound presigned PUT)
  before storing sensitive production data at scale. The application only needs the S3 API, so the swap is operational.
- The backups are on the same host. An off-host copy needs a destination and credentials chosen by the owner; until then a host loss loses both data and
  backups. This is not yet done.
- `Organization_iconAssetId_id_fkey` is a hand-maintained composite foreign key (not a Prisma relation; see the schema comment).
