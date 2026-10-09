#!/usr/bin/env bash
# Sets up only the private MinIO and ClamAV services on a replacement VPS.
# It deliberately does not enable the CoreCrow worker or alter corecrow.env.
set -euo pipefail

release="$(pwd -P)"
case "$release" in
  /var/www/releases/*) ;;
  *) echo 'Run from an immutable CoreCrow release directory on the VPS' >&2; exit 1 ;;
esac

dataset_runtime="${1:-/etc/blackpolar/corecrow-dataset.env}"
runtime=/etc/blackpolar/corecrow.env
compose_file="$release/deploy/dataset-services.compose.yml"
policy_template="$release/deploy/minio-dataset-import-policy.json"

sudo -n test -f "$dataset_runtime"
sudo -n test -f "$runtime"
sudo -n test -f "$compose_file"
sudo -n test -f "$policy_template"
[[ "$(sudo -n stat -c '%a' "$dataset_runtime")" == "600" ]] || {
  echo 'Dataset service environment must have mode 0600' >&2
  exit 1
}
[[ "$(sudo -n stat -c '%U:%G' "$dataset_runtime")" == 'root:root' ]] || {
  echo 'Dataset service environment must be owned by root:root' >&2
  exit 1
}
[[ "$(sudo -n stat -c '%U:%G' "$runtime")" == 'root:root' ]] || {
  echo 'CoreCrow runtime environment must be owned by root:root' >&2
  exit 1
}

# This root-only file is an operator-authored environment file, not repository
# configuration. Shell loading lets Docker Compose and mc receive it without
# writing a duplicate secret-bearing file into a release directory.
set -a
# shellcheck disable=SC1090
source <(sudo -n cat "$dataset_runtime")
set +a

required=(MINIO_IMAGE MC_IMAGE CLAMAV_IMAGE MINIO_DATA_DIR CLAMAV_DATABASE_DIR MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_APP_ACCESS_KEY MINIO_APP_SECRET_KEY MINIO_BUCKET MINIO_ASSET_BUCKET CORECROW_DOCKER_NETWORK)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Missing required dataset service setting: $name" >&2; exit 1; }
done
[[ "$MINIO_IMAGE" == *@sha256:* ]] || { echo 'MINIO_IMAGE must be pinned by digest' >&2; exit 1; }
[[ "$MC_IMAGE" == *@sha256:* ]] || { echo 'MC_IMAGE must be pinned by digest' >&2; exit 1; }
[[ "$CLAMAV_IMAGE" == *@sha256:* ]] || { echo 'CLAMAV_IMAGE must be pinned by digest' >&2; exit 1; }
[[ "$MINIO_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
  echo 'MINIO_BUCKET must be a DNS-compatible bucket name' >&2
  exit 1
}
[[ "$MINIO_ASSET_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
  echo 'MINIO_ASSET_BUCKET must be a DNS-compatible bucket name' >&2
  exit 1
}
[[ "$MINIO_ASSET_BUCKET" != "$MINIO_BUCKET" ]] || {
  echo 'Dataset imports and ordinary assets must use separate buckets' >&2
  exit 1
}
runtime_network="$(sudo -n awk -F= '
  $1 == "CORECROW_DOCKER_NETWORK" {
    value = substr($0, index($0, "=") + 1)
    gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "", value)
    configured = value
  }
  END { print configured }
' "$runtime")"
runtime_network="${runtime_network:-corecrow-api_default}"
[[ "$runtime_network" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
  echo 'CoreCrow runtime Docker network name is invalid' >&2
  exit 1
}
[[ "$CORECROW_DOCKER_NETWORK" == "$runtime_network" ]] || {
  echo 'Dataset service and CoreCrow runtime Docker network settings must match' >&2
  exit 1
}
sudo -n docker network inspect "$CORECROW_DOCKER_NETWORK" >/dev/null
sudo -n install -d -m 0700 "$MINIO_DATA_DIR" "$CLAMAV_DATABASE_DIR"

sudo -n docker compose --project-name corecrow-dataset --env-file "$dataset_runtime" -f "$compose_file" up -d

wait_for_health() {
  local container="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if [[ "$(sudo -n docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)" == 'healthy' ]]; then
      return 0
    fi
    sleep 3
  done
  echo "Dataset service did not become healthy: $container" >&2
  sudo -n docker logs --tail 100 "$container" >&2 || true
  return 1
}

# Fresh virus signatures can take several minutes on first boot. Its Compose
# healthcheck intentionally has a 180-second start period, so don't mistake
# that expected initialization state for a failed scanner.
wait_for_health corecrow-minio 180
wait_for_health corecrow-clamav 900

policy_file="$(mktemp)"
cleanup() { rm -f "$policy_file"; }
trap cleanup EXIT
sed -e "s/__DATASET_BUCKET__/${MINIO_BUCKET}/g" -e "s/__ASSET_BUCKET__/${MINIO_ASSET_BUCKET}/g" "$policy_template" > "$policy_file"

# MinIO is initialized with a separate application user and only the bucket
# actions required by the version-pinned import lifecycle.
sudo -n docker run --rm --network "$CORECROW_DOCKER_NETWORK" \
  --entrypoint /bin/sh \
  -v "$policy_file:/policy.json:ro" \
  --env-file "$dataset_runtime" "$MC_IMAGE" \
  -ec '
    mc alias set corecrow http://corecrow-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mb --ignore-existing "corecrow/$MINIO_BUCKET"
    mc mb --ignore-existing "corecrow/$MINIO_ASSET_BUCKET"
    mc version enable "corecrow/$MINIO_BUCKET"
    # Assets and avatars are pinned to the exact version that was scanned, so this bucket must be versioned too.
    mc version enable "corecrow/$MINIO_ASSET_BUCKET"
    # No lifecycle expiry on purpose: CoreCrow purges every version of a deleted or rejected object itself, and an
    # expiry rule could delete the pinned (scanned) version of a live asset after an overwrite.
    mc admin policy create corecrow corecrow-dataset-import /policy.json
    mc admin user add corecrow "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY"
    mc admin policy attach corecrow corecrow-dataset-import --user "$MINIO_APP_ACCESS_KEY"
  '

cat <<'NEXT_STEPS'
Private MinIO and ClamAV are healthy and both buckets have versioning enabled.
The worker remains disabled. In the root-owned /etc/blackpolar/corecrow.env,
set the documented NORTH_DATA_IMPORT_*, NORTH_ASSET_*, CORECROW_CLAMAV_* and AWS
SDK variables using the separate application identity from corecrow-dataset.env.
Then run both infrastructure verifiers before enabling uploads or the worker.
NEXT_STEPS
