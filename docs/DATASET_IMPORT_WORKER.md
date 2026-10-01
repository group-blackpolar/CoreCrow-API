# Dataset import security worker

The dataset import security worker is designed as a separate CORECROW process. It claims
durable PostgreSQL jobs, verifies private object bytes, submits them to ClamAV,
and applies the bounded ZIP/OOXML security gate. It stops at
`SECURITY_APPROVED`; workbook parsing, mapping and activation are not part of
this process yet.

**Current release gate:** the executable is deliberately disabled and exits
fail-fast before constructing the worker. Verification, malware scanning and
archive validation currently reopen an object key, so a replaceable key could
produce time-of-check/time-of-use differences between security stages. The
worker must not be enabled in any environment until uploads are promoted to an
immutable key or all stages pin and read one provider object version. There is
no environment variable that bypasses this gate.

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
database, storage or scanner configuration terminates the process with a
non-zero status. Even with complete configuration, the current immutable-object
gate terminates with a non-zero status, so this revision cannot consume jobs.

## Deployment and shutdown

After the immutable-object gate is implemented and reviewed, deploy the API and
worker from the same build artifact and schema version, but as separate
services. The worker needs private network access to PostgreSQL,
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
