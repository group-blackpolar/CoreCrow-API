# Dataset-import services on the replacement VPS

This document prepares the infrastructure required for ordinary XLSX ingestion.
It does not authorize a deployment or turn the worker on by itself. Until every
gate below has passed, `NORTH_DATA_IMPORT_WORKER_ENABLED` must stay `false` and
the application continues to reject ordinary imports safely.

## What is required

| Component | Why it is required | Deployment boundary |
| --- | --- | --- |
| Private MinIO/S3 bucket with versioning | Pins every scan and parser read to the exact object version confirmed by the API. | No host port; persistent `/data` mount. |
| Separate bucket-scoped access identity | Lets the API sign upload URLs and lets workers inspect/read/delete only import objects. | Stored only in the root-owned API runtime file. |
| ClamAV `clamd` service | Performs the malware scan before any ZIP/OOXML or SheetJS parser work. | No host port; only the CoreCrow Docker network. |
| Dataset worker | Claims durable PostgreSQL jobs and runs the security, analysis and materialization phases. | Separate container from the API, same release image. |
| Infrastructure probe | Checks S3 versioning and sends harmless content through ClamAV's real `INSTREAM` protocol. | Runs before a candidate worker starts. |
| Capacity and backups | Keeps datasets, virus signatures and PostgreSQL recoverable without exhausting the host. | Host operator responsibility. |

The API container must not be given MinIO administrator credentials. The bucket
policy supplied in [`../deploy/minio-dataset-import-policy.json`](../deploy/minio-dataset-import-policy.json)
grants only `GetBucketVersioning`, object upload, versioned read and deletion.
It constrains normal application access to the `north-data-imports/` prefix and
allows version deletion only within the isolated probe prefix. It intentionally
does not grant bucket administration or broad listing.

## Host layout and capacity

The old 2-vCPU/approximately 4-GiB VPS is not a safe target for colocated
ClamAV. The approved replacement target is at least 8 vCPU, 24 GiB RAM and
300 GB SSD. Reserve capacity for PostgreSQL, CoreCrow, Docker images, release
rollback containers, MinIO objects, ClamAV signatures and PostgreSQL dumps.

Use persistent host paths outside release directories, for example:

```text
/var/lib/blackpolar/minio
/var/lib/blackpolar/clamav
/var/backups/blackpolar
```

Do not expose MinIO port 9000, its console port 9001, ClamAV port 3310 or
PostgreSQL to the public network. They must share the configured
`CORECROW_DOCKER_NETWORK` Docker network with CoreCrow only (the compatibility
default is `corecrow-api_default`). Put the MinIO data
directory and PostgreSQL backup directory on monitored storage and include both
in the VPS backup plan. A database dump alone cannot restore uploaded source
objects; an object-store backup alone cannot restore import state.

## One-time private-service setup

1. On the replacement VPS, copy
   [`../deploy/dataset-services.env.example`](../deploy/dataset-services.env.example)
   to `/etc/blackpolar/corecrow-dataset.env`, generate distinct high-entropy
   values for all four MinIO credentials, set persistent paths, and set reviewed
   image digests for `MINIO_IMAGE`, `MC_IMAGE`, and `CLAMAV_IMAGE`.
2. Set ownership to `root:root` and permissions to `0600`. Never put this file
   in a repository, release directory, GitHub secret value, or client bundle.
3. From an immutable release directory, run:

   ```sh
   sudo bash scripts/provision-dataset-services.sh
   ```

   It creates the private containers, waits for health, creates the import
   bucket, enables bucket versioning, creates the application identity and
   attaches the narrow bucket policy. It does not read or print the API runtime
   secrets and does not enable the worker.

If a service must be recreated, retain the MinIO data and ClamAV database paths.
Recreating the MinIO data path loses immutable source files and prevents import
recovery. A bucket versioning status other than `Enabled` is a hard failure;
do not bypass it with a latest-object read.

## API runtime configuration

Add these values manually to the root-owned `/etc/blackpolar/corecrow.env`.
Use the **application** identity from `corecrow-dataset.env`, never the MinIO
root identity. Values shown as placeholders are not commands and must not be
committed.

```dotenv
NORTH_DATA_IMPORT_S3_BUCKET="corecrow-dataset-imports"
NORTH_DATA_IMPORT_S3_REGION="us-east-1"
NORTH_DATA_IMPORT_S3_ENDPOINT="http://corecrow-minio:9000"
NORTH_DATA_IMPORT_S3_FORCE_PATH_STYLE=true
NORTH_DATA_IMPORT_CLAMAV_HOST="corecrow-clamav"
NORTH_DATA_IMPORT_CLAMAV_PORT=3310
AWS_ACCESS_KEY_ID="<dataset-import-access-key>"
AWS_SECRET_ACCESS_KEY="<dataset-import-secret>"
NORTH_DATA_IMPORT_WORKER_ENABLED=false
CORECROW_DOCKER_NETWORK="corecrow-api_default"
```

The S3 endpoint is a private Docker hostname, not a public URL. Do not set
`NORTH_DATA_IMPORT_CLAMAV_SOCKET` together with the host/port pair.
`CORECROW_DOCKER_NETWORK` must exactly match the value in
`/etc/blackpolar/corecrow-dataset.env`; the provisioning script checks this
without printing either runtime file.

## Enabling and rollback

1. Deploy a verified application release. With the worker still disabled, this
   changes no import processing.
2. Run the read-only `audit-dataset-infrastructure` workflow operation and
   confirm the private service containers are healthy and configuration is
   present without revealing values.
3. On the host, run the candidate image against the root-only runtime file:

   ```sh
   sudo docker run --rm --network "<configured-corecrow-network>" \
     --env-file /etc/blackpolar/corecrow.env corecrow-api:<release> \
     node scripts/verify-dataset-infrastructure.mjs
   ```

   It writes a harmless temporary object, requires a non-null VersionId, reads
   that exact version through both HEAD and GET, verifies its checksum, removes
   the exact version, and submits harmless content to ClamAV. It must report
   that versioned storage and ClamAV are available. A failure is
   a hard stop; leave the worker disabled and investigate the private service.
4. Only after the successful probe, change
   `NORTH_DATA_IMPORT_WORKER_ENABLED=true` in the root-only API runtime file and
   deploy the same verified release. `scripts/deploy-vps.sh` repeats the probe,
   starts a candidate worker, and swaps it only after the candidate remains
   running. The old API and worker containers remain available for rollback.
5. Perform one authorized, disposable XLSX import in a non-production tenant,
   validate upload → scan → analysis → mapping → activation, then verify a
   published binding with an appropriately scoped account. This is a separate
   acceptance action; do not use the trusted demo seed as proof of the ordinary
   import path.

To stop processing during an incident, set the worker flag to `false` and make
the next verified deployment. Do not delete MinIO objects, database rows or
ClamAV data as an incident response: the jobs and immutable source versions are
evidence needed for recovery and audit.

## Ongoing operations

- Monitor filesystem capacity for MinIO, PostgreSQL and `/var/backups/blackpolar`;
  alert before any reaches 80% used. Keep enough space for a full database dump
  and the largest retained upload set.
- Back up PostgreSQL and MinIO data on independent schedules; test restoration
  into an isolated environment. Retain backup records according to the approved
  retention policy before automating deletion.
- Update ClamAV signature data and rotate the MinIO application identity through
  a planned maintenance procedure. Re-run the infrastructure probe afterward.
- Review pinned container image digests and their supply-chain/security status
  before each intentional service upgrade. Upgrade one service at a time and
  keep the prior data mount intact.
- The current materialization slice remains bounded to one worksheet, 50,000
  rows and 64 MiB child output. Chunked ingestion, append manifests and
  retention/garbage collection are still separate product work.
- Dataset workers run with `no-new-privileges`, a 256 PID ceiling, 2 GiB memory
  limit (including swap) and 1.5 CPU limit. A read-only root filesystem is not
  enabled because the isolated parser needs bounded writable temporary storage;
  move that scratch space to an explicitly mounted, size-capped `tmpfs` only
  after a production-equivalent parser acceptance test proves compatibility.
