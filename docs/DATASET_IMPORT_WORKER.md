# Dataset import security worker

The dataset import security worker is designed as a separate CORECROW process. It claims
durable PostgreSQL jobs, verifies private object bytes, submits them to ClamAV,
and applies the bounded ZIP/OOXML security gate. A second leased phase parses
only the pinned, security-approved XLSX in an isolated child process and
persists metadata-only analysis. Mapping versions are immutable; activation is
not part of this process.

**Storage release gate:** the executable verifies at startup that the import
bucket has object versioning enabled. Upload confirmation captures an immutable
provider version ID, and verification, malware scanning and archive validation
all read that exact version. Confirmation and worker startup fail closed with
`IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE` when this guarantee is absent. Object
keys, version IDs and ETags remain internal and are never returned to NORTH.

Run the compiled process with:

```text
pnpm start:dataset-import-worker
```

For local development, `pnpm dev:dataset-import-worker` restarts the worker when
source files change. Run exactly one watcher per intended worker instance.

## Required configuration

- `DATABASE_URL`: CORECROW PostgreSQL connection.
- `NORTH_DATA_IMPORT_S3_BUCKET` and `NORTH_DATA_IMPORT_S3_REGION`: private
  quarantine storage. Provider authentication comes from the AWS SDK credential
  chain; do not place credentials in job records or client contracts.
- One ClamAV endpoint: `NORTH_DATA_IMPORT_CLAMAV_SOCKET`, or both
  `NORTH_DATA_IMPORT_CLAMAV_HOST` and `NORTH_DATA_IMPORT_CLAMAV_PORT`.

Optional storage configuration is `NORTH_DATA_IMPORT_S3_ENDPOINT` and the exact
boolean `NORTH_DATA_IMPORT_S3_FORCE_PATH_STYLE`. Optional operational tuning:

- `NORTH_DATA_IMPORT_WORKER_ID` (defaults to host and process ID)
- `NORTH_DATA_IMPORT_WORKER_POLL_MS` (default 1000)
- `NORTH_DATA_IMPORT_WORKER_LEASE_MS` (default 60000)
- `NORTH_DATA_IMPORT_WORKER_HEARTBEAT_MS` (default 15000 and must be below the lease)
- `NORTH_DATA_IMPORT_WORKER_RETRY_DELAY_MS` (default 60000)
- `NORTH_DATA_IMPORT_MAX_BYTES` (default and maximum 52428800, matching the
  compressed OOXML security limit)

Configuration is validated before the polling loop begins. Missing or invalid
database, storage or scanner configuration, or a bucket whose versioning status
is not `Enabled`, terminates the process with a non-zero status.

The worker principal needs the provider equivalents of `s3:GetBucketVersioning`,
`s3:HeadObject` and `s3:GetObjectVersion` for the private import bucket. An
S3-compatible endpoint is supported only when it returns stable non-`null`
version IDs and honors `VersionId` on HEAD and GET; silently treating a
versioned read as a latest-object read is incompatible and must fail closed.

## Deployment and shutdown

Deploy the API and worker from the same build artifact and schema version, but
as separate services. The worker needs private network access to PostgreSQL,
quarantine object storage and ClamAV. It does not expose an HTTP port. Scale by
adding worker processes; database claim tokens and leases fence concurrent
processing.

The process handles `SIGINT` and `SIGTERM`, stops polling, waits for an in-flight
cycle to finish safely, then disconnects Prisma. The service supervisor's grace
period must exceed the ClamAV timeout plus expected bounded archive-validation
time. If a process is forcibly stopped, the durable lease makes the job
eligible for restart recovery after expiration.

Never use readiness based only on process liveness. A deployment check should
also prove private storage access and ClamAV reachability with a safe test
object before enabling production imports. This implementation fails closed at
runtime if either dependency later becomes unavailable.

## XLSX parser isolation

The parser child requires Node 22.13 or newer and the Node permission model. It
receives an empty environment, has no network, child-process, worker-thread or
native-addon permission, and gets filesystem read access only to its 0600
temporary workbook, parser code and installed dependencies. Its stdout is
capped at 1 MiB. This is defense in depth: deployment must independently deny
egress and instance-metadata access to parser work, use a separate
least-privilege identity, and never place cloud credentials in the worker
environment.
