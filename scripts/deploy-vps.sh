#!/usr/bin/env bash
# VPS topology established during the v1 rollout. Secrets stay on the host.
set -euo pipefail
release="$(pwd -P)"
case "$release" in /var/www/releases/*) ;; *) echo 'Run inside a release directory'; exit 1;; esac
version="${1:?Release identifier required}"
[[ "$version" =~ ^[a-zA-Z0-9-]+$ ]] || exit 1
image="corecrow-api:$version"
runtime=/etc/blackpolar/corecrow.env
sudo -n test -f "$runtime"
sudo -n docker build -t "$image" .
network="$(sudo -n docker run --rm --env-file "$runtime" "$image" node -e '
  const network = process.env.CORECROW_DOCKER_NETWORK?.trim() || "corecrow-api_default";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) process.exit(2);
  process.stdout.write(network);
')" || { echo 'Invalid CORECROW_DOCKER_NETWORK'; exit 1; }
sudo -n docker network inspect "$network" >/dev/null
backup="/var/backups/blackpolar/corecrow-$version.dump"
sudo -n sh -c 'umask 077; docker exec corecrow-db pg_dump -U blackpolar -d blackpolar -Fc > "$1"' sh "$backup"
sudo -n docker run --rm --network "$network" --env-file "$runtime" "$image" node node_modules/prisma/build/index.js migrate deploy
candidate="corecrow-check-$version"
worker_candidate="corecrow-dataset-worker-check-$version"
worker_enabled="$(sudo -n docker run --rm --env-file "$runtime" "$image" node -e 'process.stdout.write(process.env.NORTH_DATA_IMPORT_WORKER_ENABLED === "true" ? "true" : "false")')"
asset_storage_enabled="$(sudo -n docker run --rm --env-file "$runtime" "$image" node -e 'process.stdout.write(process.env.NORTH_ASSET_S3_BUCKET?.trim() ? "true" : "false")')"
sudo -n docker run -d --name "$candidate" --network "$network" --env-file "$runtime" -e CONTACT_NOTIFICATIONS_ENABLED=false -p 127.0.0.1:4101:4000 "$image" >/dev/null
cleanup() {
  sudo -n docker rm -f "$candidate" >/dev/null 2>&1 || true
  if [[ -n "$worker_candidate" ]]; then
    # Worker shutdown is cooperative; let a bounded in-flight scan release its
    # lease before removal instead of abruptly interrupting private reads.
    sudo -n docker stop --time 120 "$worker_candidate" >/dev/null 2>&1 || true
    sudo -n docker rm -f "$worker_candidate" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
ready=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4101/v1/live >/dev/null; then ready=true; break; fi
  sleep 2
done
"$ready" || { echo 'Candidate failed liveness; current API remains running'; exit 1; }
curl --silent --max-time 10 http://127.0.0.1:4101/v1/health | python3 -c 'import sys,json; s=json.load(sys.stdin); assert all(m["status"]=="available" for m in s["modules"])'
if [[ "$asset_storage_enabled" == "true" ]]; then
  # A configured asset bucket is not considered usable until CoreCrow proves a
  # private object read and a real scan through the shared clamd endpoint.
  sudo -n docker run --rm --network "$network" --env-file "$runtime" "$image" \
    node scripts/verify-asset-infrastructure.mjs
fi
if [[ "$worker_enabled" == "true" ]]; then
  # A running process alone is insufficient: prove the immutable-version check
  # and an actual private ClamAV INSTREAM request before replacing the worker.
  sudo -n docker run --rm --network "$network" --env-file "$runtime" "$image" \
    node scripts/verify-dataset-infrastructure.mjs
  sudo -n docker run -d --name "$worker_candidate" --network "$network" --env-file "$runtime" \
    --security-opt no-new-privileges:true --pids-limit 256 --memory 2g --memory-swap 2g --cpus 1.5 \
    "$image" node dist/dataset-import-worker.js >/dev/null
  worker_ready=false
  for attempt in {1..10}; do
    if [[ "$(sudo -n docker inspect -f '{{.State.Running}}' "$worker_candidate" 2>/dev/null || true)" == "true" ]]; then
      worker_ready=true
      sleep 2
      [[ "$(sudo -n docker inspect -f '{{.State.Running}}' "$worker_candidate" 2>/dev/null || true)" == "true" ]] && break
      worker_ready=false
    fi
    sleep 2
  done
  "$worker_ready" || { sudo -n docker logs "$worker_candidate" >&2 || true; echo 'Candidate dataset worker failed; current release remains running'; exit 1; }
else
  worker_candidate=""
fi
previous="corecrow-rollback-$version"
worker_previous="corecrow-dataset-worker-rollback-$version"
had_previous=false
had_worker_previous=false
restore_previous_worker() {
  if [[ "$had_worker_previous" != true ]]; then return 0; fi
  if ! sudo -n docker container inspect "$worker_previous" >/dev/null 2>&1; then
    echo 'Rollback worker container is missing; manual recovery is required' >&2
    return 1
  fi
  if sudo -n docker container inspect corecrow-dataset-worker >/dev/null 2>&1; then
    sudo -n docker rm -f corecrow-dataset-worker >/dev/null 2>&1 || true
  fi
  if ! sudo -n docker rename "$worker_previous" corecrow-dataset-worker; then
    echo 'Could not restore the previous dataset worker name' >&2
    return 1
  fi
  if ! sudo -n docker start corecrow-dataset-worker >/dev/null; then
    echo 'Could not restart the previous dataset worker' >&2
    return 1
  fi
}

# Quiesce the old worker before moving the API. If it cannot stop cleanly, the
# old API/worker pair remains intact and both candidates are discarded by trap.
if sudo -n docker container inspect corecrow-dataset-worker >/dev/null 2>&1; then
  if ! sudo -n docker stop --time 120 corecrow-dataset-worker >/dev/null; then
    echo 'Current dataset worker did not stop cleanly; API swap aborted' >&2
    exit 1
  fi
  if ! sudo -n docker rename corecrow-dataset-worker "$worker_previous"; then
    echo 'Current dataset worker could not be isolated; attempting safe restart' >&2
    sudo -n docker start corecrow-dataset-worker >/dev/null 2>&1 || true
    exit 1
  fi
  had_worker_previous=true
fi

if sudo -n docker container inspect corecrow-v1 >/dev/null 2>&1; then
  had_previous=true
  if ! sudo -n docker stop corecrow-v1 >/dev/null; then
    echo 'Current API could not be isolated; attempting worker rollback' >&2
    restore_previous_worker || true
    exit 1
  fi
  if ! sudo -n docker rename corecrow-v1 "$previous"; then
    echo 'Current API could not be renamed; attempting API and worker rollback' >&2
    sudo -n docker start corecrow-v1 >/dev/null 2>&1 || true
    restore_previous_worker || true
    exit 1
  fi
fi
if sudo -n docker run -d --name corecrow-v1 --restart unless-stopped --network "$network" --env-file "$runtime" -p 127.0.0.1:4100:4000 "$image" >/dev/null; then
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:4100/v1/live >/dev/null; then
      if [[ "$worker_enabled" == "true" ]]; then
        if ! sudo -n docker update --restart unless-stopped "$worker_candidate" >/dev/null; then
          echo 'Candidate dataset worker restart policy could not be applied; rolling back' >&2
          break
        fi
        if sudo -n docker rename "$worker_candidate" corecrow-dataset-worker; then
          echo "CoreCrow $version and dataset worker running; previous containers and database backup retained"
          exit 0
        fi
        break
      fi
      echo "CoreCrow $version running; dataset worker disabled; previous containers and database backup retained"
      exit 0
    fi
    sleep 2
  done
fi
sudo -n docker rm -f corecrow-v1 >/dev/null 2>&1 || true
if "$had_previous"; then
  sudo -n docker rename "$previous" corecrow-v1 || true
  sudo -n docker start corecrow-v1 >/dev/null || true
fi
restore_previous_worker || true
echo 'Release failed; previous API/worker pair restored where available'
exit 1
